/**
 * @version 1.1.4
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
    decompile(lscrData, nameTable = [], externalScriptType = 0, memberId = 0, options = {}) {
        try {
            const stream = new DataStream(lscrData, 'big');
            const { hLen, sType, map } = this._probeSchema(lscrData, externalScriptType);
            const cal = this._calibrateNaming(lscrData, nameTable, map, hLen, sType);

            /**
             * Internal categorical symbol resolver.
             */
            const resolveName = (id, category) => {
                if (!nameTable || nameTable.length === 0) return category.includes("prop") ? `p_${id}` : `n_${id}`;

                let shift = cal.hShift;
                if (category === "global_prop") shift = cal.gShift;
                else if (category === "movie_prop") shift = cal.mShift;

                const N = nameTable.length;
                const idx = (id - shift + (N * 50)) % N;
                let name = nameTable[idx] || `u_${id}`;

                // Handle system overrides
                if (id === LingoConfig.SPECIAL_IDS.TRACE_SCRIPT) name = 'traceScript';
                if (id === LingoConfig.SPECIAL_IDS.PLAYER) name = '_player';
                if (id === LingoConfig.SPECIAL_IDS.MOVIE) name = '_movie';
                return name;
            };

            const literals = this._parseLiterals(stream, map);
            const properties = this._parseProperties(stream, map, resolveName);
            const handlers = this._parseHandlers(stream, map, hLen);

            const scripts = [];
            const lasmBlocks = [];

            for (const handler of handlers) {
                if (handler.offset >= lscrData.length) continue;

                // Extract Arguments and Locals
                const args = this._getSymbols(stream, handler.argCount, handler.argOffset, resolveName);
                const locals = this._getSymbols(stream, handler.localCount, handler.localOffset, resolveName);

                // Auto-inject 'me' for behavior/parent scripts if missing in names
                const isObjectScript = (sType & 0xFF) === LingoConfig.SCRIPT_TYPE.LEGACY_BEHAVIOR ||
                    (sType & 0xFF) === LingoConfig.SCRIPT_TYPE.LEGACY_PARENT ||
                    (sType & 0xFF) === LingoConfig.SCRIPT_TYPE.LEGACY_CAST ||
                    (sType >> 4) > 0;

                if (isObjectScript && !args.includes('me')) args.unshift('me');

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

    _probeSchema(data, extType) {
        const hLen = data.readUInt16BE(16);
        const sType = data.readUInt16BE(18) || extType;
        const map = new Map();

        if (hLen === LingoConfig.V4_HLEN) {
            const r16 = (p) => data.readUInt16BE(p);
            const r32 = (p) => data.readUInt32BE(p);
            map.set('PROP', { count: r16(60), offset: r32(62) });
            map.set('HAND', { count: r16(72), offset: r32(74) });
            map.set('LIT ', { count: r16(78), offset: r32(80) });
            map.set('LTD ', { len: r32(84), offset: r32(88) });
        } else {
            const ds = new DataStream(data, 'big');
            ds.seek(hLen === 54 ? 52 : 50);
            const count = ds.readUint16();
            for (let i = 0; i < count; i++) {
                const tag = ds.readFourCC();
                const entry = { offset: ds.readUint32(), len: ds.readUint32() };
                map.set(tag, entry);
            }
        }
        return { hLen, sType, map };
    }

    _calibrateNaming(data, names, map, hLen, sType) {
        let hShift = 0, gShift = 0, mShift = 0;
        const info = map.get('HAND');

        if (names && names.length > 0 && info) {
            const ds = new DataStream(data, 'big');
            ds.seek(info.offset);
            const firstId = ds.readUint16();

            const nIdx = names.indexOf("new");
            const cIdx = names.indexOf("construct");

            if (firstId === nIdx || firstId === cIdx) {
                hShift = 0;
            } else if ([LingoConfig.SCRIPT_TYPE.CAST, LingoConfig.SCRIPT_TYPE.LEGACY_BEHAVIOR, LingoConfig.SCRIPT_TYPE.LEGACY_CAST].includes(sType & 0xFF)) {
                if (nIdx !== -1) hShift = (firstId - nIdx + names.length) % names.length;
                else if (cIdx !== -1) hShift = (firstId - cIdx + names.length) % names.length;
            } else {
                hShift = 0;
            }

            const tIdx = names.indexOf("traceScript");
            if (tIdx !== -1) {
                ds.seek(info.offset); ds.skip(4);
                const co = ds.readUint32();
                if (co > 0 && co < data.length) {
                    let pos = co, max = Math.min(co + 1000, data.length);
                    while (pos < max - 2) {
                        const op = data[pos];
                        const idx = (op >= LingoConfig.OP_SHIFT_THRESHOLD) ? LingoConfig.OP_SHIFT_THRESHOLD + (op % LingoConfig.OP_SHIFT_THRESHOLD) : op;
                        let len = (op >= 0xc0) ? 5 : (op >= 0x80) ? 3 : (op >= LingoConfig.OP_SHIFT_THRESHOLD) ? 2 : 1;
                        if (len > 1 && (pos + 1 + 2 <= data.length)) {
                            const id = data.readUInt16BE(pos + 1);
                            if ([LingoConfig.OP_SPEC.PUSHVAR, LingoConfig.OP_SPEC.MOVIEPROP].includes(idx)) {
                                if (mShift === 0) mShift = (id - tIdx + names.length) % names.length;
                            } else if (idx === LingoConfig.OP_SPEC.GETTOPLEVELPROP) {
                                if (gShift === 0) gShift = (id - tIdx + names.length) % names.length;
                            }
                        }
                        pos += len;
                    }
                }
            }
            if (mShift === 0) mShift = hShift;
            if (gShift === 0) gShift = hShift;
        }
        return { hShift, gShift, mShift };
    }

    _parseLiterals(stream, map) {
        const info = map.get('LIT '), dinfo = map.get('LTD ');
        if (!info || !dinfo) return [];

        stream.seek(info.offset);
        const descriptors = [];
        const count = (info.count !== undefined) ? info.count : (info.len / 8);
        for (let i = 0; i < count; i++) {
            descriptors.push({ t: stream.readUint32(), o: stream.readUint32() });
        }

        const list = [];
        for (let i = 0; i < descriptors.length; i++) {
            const desc = descriptors[i];
            stream.seek(dinfo.offset + desc.o);
            const len = (i < descriptors.length - 1) ? (descriptors[i + 1].o - desc.o) : (dinfo.len - desc.o);
            list.push(this._readLit(desc.t, stream, len));
        }
        return list;
    }

    _readLit(type, stream, len) {
        switch (type) {
            case LingoConfig.LITERAL_TYPE.INT: return new AST.IntLiteral(stream.readInt32());
            case LingoConfig.LITERAL_TYPE.STRING:
                const sl = stream.readUint32();
                return new AST.StringLiteral(sl > 0 ? stream.readString(sl - 1) : "");
            case LingoConfig.LITERAL_TYPE.FLOAT:
                stream.readUint32();
                return new AST.FloatLiteral(stream.readDouble());
            case LingoConfig.LITERAL_TYPE.SYMBOL:
                const syl = stream.readUint32();
                return new AST.SymbolLiteral(syl > 0 ? stream.readString(syl - 1) : "");
            case LingoConfig.LITERAL_TYPE.LIST:
                const count = stream.readUint32();
                const items = [];
                for (let i = 0; i < count; i++) {
                    items.push(this._readLit(stream.readUint32(), stream, stream.readUint32()));
                }
                return new AST.ListLiteral(items);
            default: return new AST.ERROR(`LT_${type}`);
        }
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
