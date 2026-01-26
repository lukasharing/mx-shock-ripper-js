/**
 * @version 1.1.2
 * LingoDecompiler.js - Advanced Multi-Phase Lingo Decompiler
 * 
 * Implements a robust state-machine for transforming Director bytecode (Lscr) 
 * back into readable Lingo source. Performs heuristic name-table calibration 
 * to handle categorical symbol scrambling.
 */

const DataStream = require('../utils/DataStream');
const AST = require('./LingoAST');
const ASTWrapper = require('./ASTWrapper');
const Bytecode = require('./Bytecode');
const { LingoConfig } = require('../Constants');

/**
 * LingoStack - Specialized LIFO container for AST reconstruction
 */
class LingoStack {
    constructor() { this._items = []; }
    push(item) { this._items.push(item); }
    pop() { return this._items.pop() || null; }
    peek() { return this._items[this._items.length - 1] || null; }
    splice(start, count) { return this._items.splice(start, count); }
    get length() { return this._items.length; }
}

class LingoDecompiler {
    constructor(logger) {
        this.log = logger || ((lvl, msg) => console.log(`[LingoDecompiler][${lvl}] ${msg}`));
    }

    /**
     * Entry point for decompiling a Lscr payload.
     * @param {Buffer} lscrData - Compiled bytecode chunk
     * @param {string[]} nameTable - Global symbol table
     * @param {number} extType - External script context (Behavior/Script/Cast)
     * @param {object} options - Generation options (lasm, etc)
     */
    decompile(lscrData, lctxData = null, nameTable = [], extType = 0, options = {}) {
        try {
            const stream = new DataStream(lscrData, 'big');
            const schema = this._probeSchema(stream, extType);
            const cal = this._calibrateNaming(lscrData, nameTable, schema);

            /**
             * Internal categorical symbol resolver.
             */
            const resolveName = (id, category) => {
                if (!nameTable || nameTable.length === 0) return `${category}_${id}`;

                let shift = cal.handlerShift;
                if (category === 'global') shift = cal.globalShift;
                else if (category === 'movie') shift = cal.movieShift;

                const N = nameTable.length;
                const idx = (id - shift + (N * 50)) % N;
                const name = nameTable[idx] || `u_${id}`;

                // Handle system overrides
                if (id === LingoConfig.SPECIAL_IDS.TRACE_SCRIPT) return 'traceScript';
                if (id === LingoConfig.SPECIAL_IDS.PLAYER) return '_player';
                if (id === LingoConfig.SPECIAL_IDS.MOVIE) return '_movie';
                return name;
            };

            const literals = this._parseLiterals(stream, schema.map);
            const properties = this._parseProperties(stream, schema.map, resolveName);
            const handlers = this._parseHandlers(stream, schema.map, schema.headerLen);

            const scripts = [];
            const lasmBlocks = [];

            for (const handler of handlers) {
                if (handler.offset >= lscrData.length) continue;

                // Extract Arguments and Locals
                const args = this._getSymbols(stream, handler.argCount, handler.argOffset, resolveName);
                const locals = this._getSymbols(stream, handler.localCount, handler.localOffset, resolveName);

                // Auto-inject 'me' for behavior/parent scripts if missing in names
                const isObject = [LingoConfig.SCRIPT_TYPE.PARENT, LingoConfig.SCRIPT_TYPE.LEGACY_PARENT, LingoConfig.SCRIPT_TYPE.LEGACY_BEHAVIOR].includes(schema.scriptType);
                if (isObject && !args.includes('me')) args.unshift('me');

                const hName = resolveName(handler.nameId, 'handler');
                const codes = Bytecode.parse(lscrData, handler.offset, handler.length, literals, resolveName);
                const ast = new ASTWrapper(new AST.Handler(hName, args));

                const context = {
                    stack: new LingoStack(),
                    ast,
                    index: 0,
                    codes,
                    handler: { locals, args, name: hName },
                    literals,
                    handlers,
                    resolver: resolveName,
                    activeCase: null
                };

                // Phase 4: Control Flow Analysis & Translation
                for (let i = 0; i < codes.length; i++) {
                    const bc = codes[i];
                    context.index = i;

                    while (ast.currentBlock.endPos > 0 && bc.pos >= ast.currentBlock.endPos) {
                        ast.exitBlock();
                    }

                    if (context.activeCase && !context.activeCase.isOtherwiseActive) {
                        if (ast.currentBlock.parent === ast.root && bc.opcode !== 'peek' && bc.opcode !== 'pop' &&
                            context.activeCase.finalPos > 0 && bc.pos < context.activeCase.finalPos) {
                            const otherwise = new AST.CaseBranch([]);
                            otherwise.block.endPos = context.activeCase.finalPos;
                            context.activeCase.addBranch(otherwise);
                            context.activeCase.isOtherwiseActive = true;
                            ast.enterBlock(otherwise.block);
                        }
                    }

                    if (context.activeCase && context.activeCase.finalPos > 0 && bc.pos >= context.activeCase.finalPos) {
                        context.activeCase = null;
                    }

                    this._processInstruction(bc, context);
                }

                scripts.push(ast.toString());
                if (options.lasm) {
                    lasmBlocks.push(`\n; Handler: ${hName}\n` +
                        codes.map(c => `[${c.pos.toString().padStart(5)}] ${c.opcode.padEnd(14)} ${c.obj}`).join('\n'));
                }
            }

            let source = properties.length > 0 ? `property ${properties.join(', ')}\n\n` : '';
            source += scripts.join('\n\n');

            return options.lasm ? { text: source, lasm: lasmBlocks.join('\n') } : { text: source };

        } catch (e) {
            this.log('ERROR', `Decompilation failed: ${e.message}`);
            return { text: `-- Extraction Error: ${e.message}\n${e.stack}` };
        }
    }

    _probeSchema(ds, extType) {
        ds.seek(16);
        const headerLen = ds.readUint16();
        const scriptType = ds.readUint16() || extType;
        const map = new Map();

        if (headerLen === LingoConfig.V4_HLEN) {
            ds.seek(60); map.set('PROP', { count: ds.readUint16(), offset: ds.readUint32() });
            ds.seek(72); map.set('HAND', { count: ds.readUint16(), offset: ds.readUint32() });
            ds.seek(78); map.set('LIT ', { count: ds.readUint16(), offset: ds.readUint32() });
            ds.seek(84); map.set('LTD ', { len: ds.readUint32(), offset: ds.readUint32() });
        } else {
            ds.seek(headerLen === 54 ? 52 : 50);
            const tagCount = ds.readUint16();
            for (let i = 0; i < tagCount; i++) {
                map.set(ds.readFourCC(), { offset: ds.readUint32(), len: ds.readUint32() });
            }
        }
        return { headerLen, scriptType, map };
    }

    _calibrateNaming(data, names, schema) {
        let handlerShift = 0, globalShift = 0, movieShift = 0;
        const handInfo = schema.map.get('HAND');
        if (names?.length > 0 && handInfo) {
            const ds = new DataStream(data, 'big');
            ds.seek(handInfo.offset);
            const firstId = ds.readUint16();
            const nIdx = names.indexOf('new'), cIdx = names.indexOf('construct');
            if (firstId === nIdx || firstId === cIdx) handlerShift = 0;
            else if (nIdx !== -1) handlerShift = (firstId - nIdx + names.length) % names.length;

            const tsIdx = names.indexOf('traceScript');
            if (tsIdx !== -1) {
                ds.seek(handInfo.offset + 4);
                const codeOff = ds.readUint32();
                if (codeOff > 0 && codeOff < data.length) {
                    for (let p = codeOff; p < Math.min(codeOff + 500, data.length - 2); p++) {
                        if (data[p] === 0x41) {
                            globalShift = (data.readUInt16BE(p + 1) - tsIdx + names.length) % names.length;
                            break;
                        }
                    }
                }
            }
        }
        return { handlerShift, globalShift, movieShift };
    }

    _parseLiterals(ds, map) {
        const info = map.get('LIT '), data = map.get('LTD ');
        const results = [];
        if (!info || !data) return results;
        ds.seek(info.offset);
        const offsets = Array.from({ length: info.count || (info.len / 4) }, () => ds.readUint32());
        for (const off of offsets) {
            ds.seek(data.offset + off);
            const type = ds.readUint32(), len = ds.readUint32();
            if (type === LingoConfig.LITERAL_TYPE.STRING) results.push(ds.readString(len).replace(/\0/g, ''));
            else if (type === LingoConfig.LITERAL_TYPE.INT) results.push(ds.readInt32());
            else if (type === LingoConfig.LITERAL_TYPE.FLOAT) { ds.readUint32(); results.push(ds.readDouble()); }
            else if (type === LingoConfig.LITERAL_TYPE.SYMBOL) results.push(ds.readString(len).replace(/\0/g, ''));
            else results.push(0);
        }
        return results;
    }

    _parseProperties(ds, map, getName) {
        const info = map.get('PROP');
        const results = [];
        if (!info) return results;
        ds.seek(info.offset);
        for (let i = 0; i < (info.count || (info.len / 2)); i++) results.push(getName(ds.readUint16(), 'prop'));
        return results;
    }

    _parseHandlers(ds, map, hLen) {
        const info = map.get('HAND');
        const results = [];
        if (!info) return results;
        ds.seek(info.offset);
        const step = (hLen === LingoConfig.V4_HLEN) ? 46 : hLen;
        for (let i = 0; i < (info.count || (info.len / step)); i++) {
            const start = ds.position;
            results.push({
                nameId: ds.readInt16(), hId: ds.readInt16(), length: ds.readUint32(), offset: ds.readUint32(),
                argCount: ds.readUint16(), argOffset: ds.readUint32(),
                localCount: ds.readUint16(), localOffset: ds.readUint32()
            });
            ds.seek(start + step);
        }
        return results;
    }

    _getSymbols(stream, count, offset, getName) {
        if (count === 0 || offset === 0) return [];
        const saved = stream.position;
        stream.seek(offset);
        const res = [];
        for (let k = 0; k < count; k++) {
            const sym = getName(stream.readUint16(), 'handler');
            if (sym !== 'constant' && sym !== 'me') res.push(sym);
        }
        stream.seek(saved);
        return res;
    }

    _processInstruction(bc, ctx) {
        try {
            AST.translate(bc, ctx);
        } catch (e) {
            ctx.ast.addStatement(new AST.ERROR(`${bc.opcode}: ${e.message}`));
        }
    }
}

module.exports = LingoDecompiler;
