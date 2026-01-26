/**
 * @version 1.0.0
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

                const codes = Bytecode.parse(lscrData, handler.offset, handler.length, literals, resolveName);
                const ast = new ASTWrapper(handler, resolveName);
                const context = { stack: new LingoStack(), ast, index: 0, codes };

                for (let i = 0; i < codes.length; i++) {
                    context.index = i;
                    this._processInstruction(codes[i], context);
                }

                scripts.push(ast.toString());
                if (options.lasm) {
                    lasmBlocks.push(`\n; Handler: ${resolveName(handler.nameId, 'handler')}\n` +
                        codes.map(c => `[${c.pos.toString().padStart(5)}] ${c.opcode.padEnd(14)} ${c.obj}`).join('\n'));
                }
            }

            let source = properties.length > 0 ? `property ${properties.join(', ')}\n\n` : '';
            source += scripts.join('\n\n');

            return options.lasm ? { text: source, lasm: lasmBlocks.join('\n') } : { text: source };

        } catch (e) {
            this.log('ERROR', `Decompilation failed: ${e.message}`);
            return { text: `-- Extraction Error: ${e.message}` };
        }
    }

    /**
     * Determines if the script is legacy (V4) or modern (V5+).
     */
    _probeSchema(ds, extType) {
        ds.seek(16);
        const headerLen = ds.readUint16();
        const scriptType = ds.readUint16() || extType;
        const map = new Map();

        if (headerLen === 92) { // V4 Static Schema
            ds.seek(60); map.set('PROP', { count: ds.readUint16(), offset: ds.readUint32() });
            ds.seek(72); map.set('HAND', { count: ds.readUint16(), offset: ds.readUint32() });
            ds.seek(78); map.set('LIT ', { count: ds.readUint16(), offset: ds.readUint32() });
            ds.seek(84); map.set('LTD ', { len: ds.readUint32(), offset: ds.readUint32() });
        } else { // V5+ Dynamic Schema
            ds.seek(headerLen === 54 ? 52 : 50);
            const tagCount = ds.readUint16();
            for (let i = 0; i < tagCount; i++) {
                map.set(ds.readFourCC(), { offset: ds.readUint32(), len: ds.readUint32() });
            }
        }
        return { headerLen, scriptType, map };
    }

    /**
     * Heuristically resolves the shift between bytecode IDs and Name Table indices.
     */
    _calibrateNaming(data, names, schema) {
        let handlerShift = 0, globalShift = 0, movieShift = 0;
        const handInfo = schema.map.get('HAND');

        if (names?.length > 0 && handInfo) {
            const ds = new DataStream(data, 'big');
            ds.seek(handInfo.offset);
            const firstId = ds.readUint16();

            const newIdx = names.indexOf('new');
            const constructIdx = names.indexOf('construct');

            // Strategy: Align 'new' or 'construct' for Cast/Behavior scripts
            if (firstId === newIdx || firstId === constructIdx) {
                handlerShift = 0;
            } else if (newIdx !== -1) {
                handlerShift = (firstId - newIdx + names.length) % names.length;
            }

            // Global calibration using 'traceScript' heuristic
            const tsIdx = names.indexOf('traceScript');
            if (tsIdx !== -1) {
                ds.seek(handInfo.offset + 4);
                const codeOff = ds.readUint32();
                if (codeOff > 0 && codeOff < data.length) {
                    for (let p = codeOff; p < Math.min(codeOff + 500, data.length - 2); p++) {
                        if (data[p] === 0x41) { // getprop opcode
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
        const info = map.get('LIT ');
        const data = map.get('LTD ');
        const results = [];
        if (!info || !data) return results;

        ds.seek(info.offset);
        const offsets = Array.from({ length: info.count }, () => ds.readUint32());

        for (const off of offsets) {
            ds.seek(data.offset + off);
            const type = ds.readUint32();
            const len = ds.readUint32();
            if (type === 1) results.push(ds.readString(len).replace(/\0/g, ''));
            else if (type === 4) results.push(ds.readDouble());
            else results.push(0);
        }
        return results;
    }

    _parseProperties(ds, map, getName) {
        const info = map.get('PROP');
        const results = [];
        if (!info) return results;
        ds.seek(info.offset);
        for (let i = 0; i < (info.count || info.len / 2); i++) {
            results.push(getName(ds.readUint16(), 'prop'));
        }
        return results;
    }

    _parseHandlers(ds, map, hLen) {
        const info = map.get('HAND');
        const results = [];
        if (!info) return results;
        ds.seek(info.offset);
        const isV4 = hLen === 92;
        const step = isV4 ? 14 : 18;

        for (let i = 0; i < (info.count || (info.len / step)); i++) {
            const start = ds.position;
            const nameId = ds.readInt16();
            ds.skip(2); // handlerId
            const length = ds.readUint32();
            const offset = ds.readUint32();
            results.push({ nameId, length, offset });
            ds.seek(start + step);
        }
        return results;
    }

    /**
     * Dispatches bytecode to AST transformation logic.
     */
    _processInstruction(bc, ctx) {
        try {
            AST.translate(bc, ctx);
        } catch (e) {
            // Error resilience for production
        }
    }
}

module.exports = LingoDecompiler;
