/**
 * @version 1.4.2
 * LingoDecompiler.js
 * 
 * A robust Lingo bytecode decompiler using multi-phase 
 * control flow reconstruction and statement recovery.
 */

const DataStream = require('../utils/DataStream');
const AST = require('./LingoAST');
const ASTWrapper = require('./ASTWrapper');
const Bytecode = require('./Bytecode');
const { LingoConfig, LingoOpcode } = require('../Constants');

/**
 * Helper class for managing the decompiler stack
 */
class LingoStack {
    constructor() { this._items = []; }
    push(item) { this._items.push(item); }
    pop() { return this._items.length > 0 ? this._items.pop() : new AST.ERROR("Stack Underflow"); }
    peek() { return this._items.length > 0 ? this._items[this._items.length - 1] : null; }
    splice(start, count) { return this._items.splice(start, count); }
    get length() { return this._items.length; }
}

class LingoDecompiler {
    constructor(logger, extractor) {
        this.log = logger || ((lvl, msg) => { });
        this.extractor = extractor;
        AST.setLogger(this.log);
    }

    /**
     * Main entry point for decompiling a Lingo script.
     * @param {Buffer} lscrData - Raw Lscr chunk data.
     * @param {string[]} nameTable - Parsed symbol names from Lnam.
     * @param {number} externalScriptType - Fallback script type if header is empty.
     * @param {number} memberId - For logging/debugging.
     * @param {object} options - Options (e.g., { lasm: true }).
     */
    decompile(lscrData, nameTable, externalScriptType = 0, memberId = 0, options = {}) {
        this.log('DEBUG', `[LingoDecompiler] Decompiling script ${memberId}`);
        try {
            if (!lscrData || lscrData.length < 132) {
                return options.lasm ? { source: "-- Script buffer too small/empty", lasm: "" } : "-- Script buffer too small/empty";
            }
            const endianness = options.endianness || 'big';
            const stream = new DataStream(lscrData, endianness);
            const { hLen, sType, map } = this._getSchema(lscrData, externalScriptType);
            const cal = this._getCalibration(lscrData, nameTable, map, hLen, sType, memberId);

            /**
             * Resolves a bytecode ID to a name based on the calibrated shift.
             * Uses a simple 2D map cache to bypass math and slow string allocations.
             */
            const nameCache = { 'handle': [], 'global': [], 'movie_prop': [], 'global_prop': [] };
            const getName = (id, type) => {
                if (id === undefined || id === null) return `unk_${type}`;
                let cacheGroup = nameCache[type];
                if (!cacheGroup) { cacheGroup = []; nameCache[type] = cacheGroup; }
                if (cacheGroup[id] !== undefined) return cacheGroup[id];

                if (!nameTable || nameTable.length === 0) {
                    const fallback = type.includes("prop") ? `p_${id}` : `n_${id}`;
                    cacheGroup[id] = fallback;
                    return fallback;
                }

                let shift = cal.hShift;
                if (type === "global_prop") shift = cal.gShift;
                else if (type === "movie_prop") shift = cal.mShift;

                const N = nameTable.length;
                const idx = (id - shift + (N * 50)) % N;
                const name = nameTable[idx] || `u_${id}`;

                cacheGroup[id] = name;
                return name;
            };

            const literals = this._getLiterals(stream, map);
            const properties = this._getProperties(stream, map, getName);
            const handlers = this._getHandlers(stream, map, hLen);
            const scriptBlocks = [], asmBlocks = [];

            // Decompile each handler individually
            for (const handler of handlers) {
                if (handler.off >= lscrData.length) continue;

                const hName = getName(handler.nameId, "handle");
                const argInfo = this._getSymbols(stream, handler.aCnt, handler.aOff, getName);
                const args = argInfo.symbols || argInfo; // Support both old and new return format
                const meWasFiltered = argInfo.meWasFiltered || false;

                // Auto-inject 'me' for script/object types if missing
                // sType often contains ScriptType in high nibble and MemberType in low nibble
                const isObjectScript = (sType & 0xFF) === LingoConfig.SCRIPT_TYPE.LEGACY_BEHAVIOR ||
                    (sType & 0xFF) === LingoConfig.SCRIPT_TYPE.LEGACY_PARENT ||
                    (sType & 0xFF) === LingoConfig.SCRIPT_TYPE.LEGACY_CAST ||
                    (sType >> 4) > 0;

                if ((isObjectScript || meWasFiltered) && !args.includes('me')) {
                    args.unshift('me');
                }

                const codes = this._getBytecodes(lscrData.slice(handler.off, handler.off + handler.len), handler.off);
                this._tagLoops(codes, getName);
                const stack = new LingoStack();
                const ast = new ASTWrapper(new AST.Handler(hName, args));

                const localInfo = this._getSymbols(stream, handler.lCnt, handler.lOff, getName);
                const locals = localInfo.symbols || localInfo;
                const context = {
                    stack, ast, resolver: getName,
                    handler: { locals, args, name: hName, meWasFiltered },
                    literals: literals,
                    isV4: (hLen === LingoConfig.V4_HLEN),
                    sType,
                    codes, index: 0, memberId,
                    handlers: handlers
                };






                // Sequential instruction processing
                for (let i = 0; i < codes.length; i++) {
                    const bc = codes[i];
                    context.index = i;

                    // Close control flow blocks if jump target reached
                    let safetyShift = 0;
                    while (ast.currentBlock && ast.currentBlock.endPos > 0 && bc.pos >= ast.currentBlock.endPos && safetyShift < 100) {
                        ast.exitBlock();
                        safetyShift++;
                    }

                    // Detection for 'otherwise' branch
                    if (context.activeCase && !context.activeCase.isOtherwiseActive) {
                        const isAtCaseLevel = ast.currentBlock.statements[ast.currentBlock.statements.length - 1] === context.activeCase;
                        if (isAtCaseLevel && context.activeCase.finalPos > 0 && bc.pos < context.activeCase.finalPos) {
                            // Look ahead to see if there is a jmpifz before the next absolute jump or the end of the case.
                            // Case checks always consist of peek/push/eq/jmpifz.
                            let hasJmpifz = false;
                            for (let j = context.index; j < context.codes.length; j++) {
                                const peekBc = context.codes[j];
                                if (peekBc.pos >= context.activeCase.finalPos || peekBc.opcode === 'jmp') break;
                                if (peekBc.opcode === 'jmpifz' || peekBc.opcode === 'jmp_if_z') {
                                    hasJmpifz = true;
                                    break;
                                }
                            }

                            // Also skip standalone 'pop' which cleans up the peeked value before otherwise body
                            if (!hasJmpifz && bc.opcode !== 'pop') {
                                const otherwise = new AST.CaseBranch([]);
                                otherwise.block.endPos = context.activeCase.finalPos;
                                context.activeCase.addBranch(otherwise);
                                context.activeCase.isOtherwiseActive = true;
                                ast.enterBlock(otherwise.block);
                            }
                        }
                    }

                    // Special case for ending an 'otherwise' block or CaseStatement
                    if (context.activeCase && context.activeCase.finalPos > 0 && bc.pos >= context.activeCase.finalPos) {
                        context.activeCase = null;
                    }

                    try {
                        this._translate(bc, context);
                    } catch (e) {
                        this.log('ERROR', `Translation failed at pos ${bc.pos} (${bc.opcode}): ${e.message}\nStack: ${e.stack}`);
                    }
                }


                scriptBlocks.push(ast.toString());

                if (options.lasm) {
                    let asm = `\n; --- Handler: ${hName} ---\n`;
                    for (const bc of codes) {
                        asm += `[${bc.pos.toString().padStart(6)}]  ${bc.opcode.padEnd(16)} 0x${bc.obj.toString(16).padStart(4, '0')} (${bc.obj})\n`;
                    }
                    asmBlocks.push(asm);
                }
            }

            let source = "";
            if (properties.length > 0) source += `property ${properties.join(', ')}\n\n`;
            source += scriptBlocks.join('\n\n');

            return options.lasm ? { source, lasm: asmBlocks.join("\n") } : source;
        } catch (e) {
            this.log('ERROR', `Decompilation failed [ID:${memberId}]: ${e.message}\nStack: ${e.stack}`);
            return options.lasm ? { source: `-- Error: ${e.message}`, lasm: "" } : `-- Error: ${e.message}`;
        }
    }

    /**
     * Determines script structure and maps internal segments.
     */
    _getSchema(data, extType) {
        try {
            if (data.length < 20) return { hLen: 0, sType: extType, map: new Map() };
            const hLen = data.readUInt16BE(16);
            const sType = data.readUInt16BE(18) || extType;
            const map = new Map();

            if (hLen === LingoConfig.V4_HLEN) {
                // Legacy Director 4.0 schema
                const r16 = (p) => data.readUInt16BE(p);
                const r32 = (p) => data.readUInt32BE(p);
                map.set('PROP', { count: r16(60), offset: r32(62) });
                map.set('HAND', { count: r16(72), offset: r32(74) });
                map.set('LIT ', { count: r16(78), offset: r32(80) });
                map.set('LTD ', { len: r32(84), offset: r32(88) });
            } else {
                // Modern V5+ schema
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
        } catch (e) {
            return { hLen: 0, sType: extType, map: new Map() };
        }
    }

    /**
     * Probes symbols to calculate relative Name Table offsets.
     */
    _getCalibration(data, names, map, hLen, sType, memberId) {
        let hShift = 0, gShift = 0, mShift = 0;
        const info = map.get('HAND');

        if (names && names.length > 0 && info) {
            const ds = new DataStream(data, 'big');
            ds.seek(info.offset);
            const firstId = ds.readUint16();
            const handlers = this._getHandlers(new DataStream(data, 'big'), map, hLen);
            const nIdx = names.indexOf("new");
            const cIdx = names.indexOf("construct");
            const rawHandlerScore = this._scoreHandlerShift(names, handlers, 0);
            const shiftCandidates = [];

            if (nIdx !== -1) {
                shiftCandidates.push({
                    label: 'new',
                    shift: (firstId - nIdx + names.length) % names.length
                });
            }
            if (cIdx !== -1) {
                const constructShift = (firstId - cIdx + names.length) % names.length;
                if (!shiftCandidates.some(candidate => candidate.shift === constructShift)) {
                    shiftCandidates.push({
                        label: 'construct',
                        shift: constructShift
                    });
                }
            }

            if (firstId === nIdx || firstId === cIdx) {
                hShift = 0;
            } else if ([LingoConfig.SCRIPT_TYPE.CAST, LingoConfig.SCRIPT_TYPE.LEGACY_BEHAVIOR, LingoConfig.SCRIPT_TYPE.LEGACY_CAST, LingoConfig.SCRIPT_TYPE.PARENT, LingoConfig.SCRIPT_TYPE.LEGACY_PARENT].includes(sType) && shiftCandidates.length > 0) {
                let bestCandidate = { label: 'raw', shift: 0, score: rawHandlerScore };
                for (const candidate of shiftCandidates) {
                    const score = this._scoreHandlerShift(names, handlers, candidate.shift);
                    if (score > bestCandidate.score) {
                        bestCandidate = { ...candidate, score };
                    }
                }

                hShift = bestCandidate.shift;
                if (hShift !== 0) {
                    this.log(
                        'DEBUG',
                        `[ID:${memberId}] Calibrated hShift=${hShift} using '${bestCandidate.label}' (rawScore=${rawHandlerScore}, shiftedScore=${bestCandidate.score}, firstId=${firstId})`
                    );
                }
            } else {
                hShift = 0;
            }

            // Probe 2 removed: the assumption that the first getmovieprop is traceScript is fundamentally flawed.
        }
        return { hShift, gShift, mShift };

    }

    _scoreHandlerShift(names, handlers, shift) {
        if (!Array.isArray(names) || names.length === 0 || !Array.isArray(handlers) || handlers.length === 0) {
            return Number.NEGATIVE_INFINITY;
        }

        let score = 0;
        const sample = handlers.slice(0, Math.min(6, handlers.length));
        for (const handler of sample) {
            const resolvedName = this._resolveShiftedName(names, handler.nameId, shift);
            if (this._looksLikeHandlerName(resolvedName)) {
                score += 3;
            } else {
                score -= 4;
            }
        }
        return score;
    }

    _isSymbolLiteral(node) {
        return node instanceof AST.SymbolLiteral || (node instanceof AST.Literal && node.type === 'symbol');
    }

    _buildPropertyAccess(target, propNode) {
        if (!this._isSymbolLiteral(propNode)) return null;
        return new AST.BinaryOperator('.', target, new AST.VarReference(propNode.value));
    }

    _buildIndexedAccess(base, start, end = null) {
        const indexExpr = end ? new AST.RangeExpression(start, end) : start;
        return new AST.BinaryOperator('[]', base, indexExpr);
    }

    _readV4Property(propertyType, propertyID, ctx) {
        const { stack, isV4 } = ctx;
        if (typeof propertyID !== 'number') {
            return new AST.VarReference(`v4prop_${propertyType}_${propertyID}`);
        }

        switch (propertyType) {
            case 0x00:
                if (propertyID <= 0x0b) {
                    return new AST.TheExpression(LingoConfig.V4_MOVIE_PROPS[propertyID] || `movieProp_${propertyID}`);
                }
                return new AST.LastChunkExpression(propertyID - 0x0b, stack.pop());

            case 0x01:
                return new AST.ChunkCountExpression(propertyID, stack.pop());

            case 0x06: {
                const spriteID = stack.pop();
                const propName = LingoConfig.V4_SPRITE_PROPS[propertyID] || `spriteProp_${propertyID}`;
                return new AST.ObjectPropertyExpression(new AST.MemberExpression('sprite', spriteID), propName);
            }

            case 0x07:
                return new AST.TheExpression(LingoConfig.V4_ANIMATION_PROPS[propertyID] || `animationProp_${propertyID}`);

            case 0x08: {
                const propName = LingoConfig.V4_ANIMATION2_PROPS[propertyID] || `animation2Prop_${propertyID}`;
                if (propertyID === 0x02 && !isV4 && stack.length > 0) {
                    const castLib = stack.peek();
                    if (castLib instanceof AST.IntLiteral && castLib.value === 0) {
                        stack.pop();
                        return new AST.TheExpression(propName);
                    }
                    if (castLib && !(castLib instanceof AST.ERROR)) {
                        return new AST.ObjectPropertyExpression(new AST.MemberExpression('castLib', stack.pop()), propName);
                    }
                }
                return new AST.TheExpression(propName);
            }

            case 0x09:
            case 0x0a:
            case 0x0b:
            case 0x0c:
            case 0x0d:
            case 0x0e:
            case 0x0f:
            case 0x10:
            case 0x11:
            case 0x12:
            case 0x13:
            case 0x14:
            case 0x15: {
                const propName = LingoConfig.V4_MEMBER_PROPS[propertyID] || `memberProp_${propertyID}`;
                const castID = !isV4 ? stack.pop() : null;
                const memberID = stack.pop();

                let prefix;
                if (propertyType === 0x0b || propertyType === 0x0c) {
                    prefix = 'field';
                } else if (propertyType === 0x14 || propertyType === 0x15) {
                    prefix = 'script';
                } else {
                    prefix = !isV4 ? 'member' : 'cast';
                }

                const memberExpr = new AST.MemberExpression(prefix, memberID, castID);
                const entity = (propertyType === 0x0a || propertyType === 0x0c || propertyType === 0x15)
                    ? this._readChunkRef(stack, memberExpr)
                    : memberExpr;

                return new AST.ObjectPropertyExpression(entity, propName);
            }

            default:
                return new AST.VarReference(`v4prop_${propertyType}_${propertyID}`);
        }
    }

    _resolveShiftedName(names, id, shift) {
        if (!Array.isArray(names) || names.length === 0 || id === undefined || id === null) return '';
        const idx = (id - shift + (names.length * 50)) % names.length;
        return names[idx] || '';
    }

    _looksLikeHandlerName(name) {
        if (typeof name !== 'string' || !name) return false;
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return false;

        const suspicious = new Set([
            'me',
            'constant',
            'call',
            'return',
            'try',
            'catch',
            'param',
            'paramCount',
            'stringp',
            'objectp',
            'voidp',
            'integerp',
            'symbolp',
            'width',
            'height'
        ]);

        if (suspicious.has(name)) return false;
        if (/^[alnpu]_\d+$/.test(name)) return false;
        if (/^[tplag][A-Z]/.test(name)) return false;
        return true;
    }

    /**
     * Extracts constant values from the Literal segments.
     */
    _getLiterals(stream, map) {
        const info = map.get('LIT '), dinfo = map.get('LTD ');
        if (!info || !dinfo) return [];
        if (info.offset >= stream.buffer.length) return [];

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
            case LingoConfig.LITERAL_TYPE.STRING: const sl = stream.readUint32(); return new AST.StringLiteral(sl > 0 ? stream.readString(sl - 1) : "");
            case LingoConfig.LITERAL_TYPE.FLOAT:
            case LingoConfig.LITERAL_TYPE.FLOAT_V4: stream.readUint32(); return new AST.FloatLiteral(stream.readDouble());
            case LingoConfig.LITERAL_TYPE.SYMBOL: const syl = stream.readUint32(); return new AST.SymbolLiteral(syl > 0 ? stream.readString(syl - 1) : "");
            case LingoConfig.LITERAL_TYPE.LIST:
                const count = stream.readUint32();
                const items = [];
                for (let i = 0; i < count; i++) items.push(this._readLit(stream.readUint32(), stream, stream.readUint32()));
                return new AST.ListLiteral(items);
            default: return new AST.ERROR(`LT_${type}`);
        }
    }

    /**
     * Extracts property declarations.
     */
    _getProperties(stream, map, getName) {
        const info = map.get('PROP'); if (!info) return [];
        if (info.offset >= stream.buffer.length) return [];
        stream.seek(info.offset);
        const res = [];
        const count = (info.count !== undefined) ? info.count : (info.len / 2);
        for (let i = 0; i < count; i++) {
            const name = getName(stream.readUint16(), "handle");
            // Scrub system/junk properties
            if (name && name !== 'pNoiseStripped' && name !== 'constant') res.push(name);
        }
        return res;
    }

    /**
     * Maps handler metadata (entry point, argument count, locals).
     */
    _getHandlers(stream, map, hLen) {
        const info = map.get('HAND'); if (!info) return [];
        if (info.offset >= stream.buffer.length) return [];
        stream.seek(info.offset);
        const res = [];
        const size = (hLen === LingoConfig.V4_HLEN) ? 46 : hLen;
        const count = (info.count !== undefined) ? info.count : (info.len / size);
        for (let i = 0; i < count; i++) {
            res.push({
                nameId: stream.readUint16(), hId: stream.readUint16(), len: stream.readUint32(), off: stream.readUint32(),
                aCnt: stream.readUint16(), aOff: stream.readUint32(), lCnt: stream.readUint16(), lOff: stream.readUint32()
            });
            stream.skip(size - 24);
        }
        return res;
    }

    /**
     * Reads symbol names from a specific segment offset.
     */
    _getSymbols(stream, count, offset, getName) {
        if (offset < 0 || offset >= stream.buffer.length) {
            return { symbols: [], meWasFiltered: false };
        }
        const saved = stream.position;
        stream.seek(offset);
        const res = [];
        let meWasFiltered = false;
        for (let k = 0; k < count; k++) {
            const sym = getName(stream.readUint16(), "handle");
            if (sym === 'me') {
                meWasFiltered = true;
            } else if (sym !== 'constant') {
                res.push(sym);
            }
        }
        stream.seek(saved);
        return { symbols: res, meWasFiltered };
    }

    /**
     * Converts raw handler bytes into a list of Bytecode objects.
     */
    _getBytecodes(data, base) {
        const stream = new DataStream(data, 'big'); const res = [];
        while (stream.position < data.length) {
            const pos = base + stream.position, op = stream.readUint8();
            const idx = op >= LingoConfig.OP_SHIFT_THRESHOLD ? LingoConfig.OP_SHIFT_THRESHOLD + op % LingoConfig.OP_SHIFT_THRESHOLD : op;
            let obj = 0, len = 1;

            // Handle variable length opcodes
            if (op >= 0xc0) {
                if (idx === 0x31) obj = stream.readFloat();
                else obj = (idx === 0x6f) ? stream.readInt32() : stream.readUint32();
                len = 5;
            } else if (op >= 0x80) {
                obj = [0x41, 0x6e, 0x53, 0x54, 0x55, 0x56, 0x6f].includes(idx) ? stream.readInt16() : stream.readUint16();
                len = 3;
            } else if (op >= LingoConfig.OP_SHIFT_THRESHOLD) {
                obj = (idx === 0x41) ? stream.readInt8() : stream.readUint8();
                len = 2;
            }
            res.push(new Bytecode(op, obj, len, pos));
        }
        return res;
    }

    /**
     * Reconstructs a variable or field reference based on type.
     */
    _readVar(stack, varType, resolver, ctx) {
        let castLib = null;
        // field cast ID supported from D5.0 (sType high byte often reflects version or specific bit-field)
        // In this project sType 0x4/0x8/x05 often maps to D5+ styles
        if (varType === 0x06 && ctx.sType >= 0x05) {
            castLib = stack.pop();
        }
        const idNode = stack.pop();
        if (!idNode || idNode instanceof AST.ERROR) {
            return new AST.ERROR(`VarRef ${varType}: ${idNode?.msg || 'Stack Underflow'}`);
        }

        const id = (idNode.value !== undefined) ? idNode.value : null;

        switch (varType) {
            case 0x01: // global
            case 0x02: // global
                if (idNode instanceof AST.VarReference || idNode instanceof AST.PropertyReference) return idNode;
                if (id === null) return new AST.ERROR(`VarRef ${varType}: Invalid global id`);
                return new AST.VarReference(resolver(id, "global"));
            case 0x03: // property/instance
                if (idNode instanceof AST.VarReference || idNode instanceof AST.PropertyReference) return idNode;
                if (id === null) return new AST.ERROR(`VarRef ${varType}: Invalid property id`);
                return new AST.VarReference(resolver(id, "handle"));
            case 0x04: // arg
                if (idNode instanceof AST.ParamReference) return idNode;
                if (id === null) return new AST.ERROR(`VarRef ${varType}: Invalid arg id`);
                return new AST.ParamReference(ctx.handler.args[id] || `a_${id}`);
            case 0x05: // local
                if (idNode instanceof AST.LocalVarReference) return idNode;
                if (id === null) return new AST.ERROR(`VarRef ${varType}: Invalid local id`);
                return new AST.LocalVarReference(ctx.handler.locals[id] || `l_${id}`);
            case 0x06: // field
                return new AST.MemberExpression("field", idNode, castLib);
            default:
                return new AST.ERROR(`Unhandled var type ${varType}`);
        }
    }

    _sameNode(a, b) {
        if (!a || !b) return false;
        if (a === b) return true;
        return a.toString() === b.toString();
    }

    _isOpcode(bc, ...names) {
        return !!bc && names.includes(bc.opcode);
    }

    _getLoopPosMap(codes) {
        const posMap = new Map();
        for (let i = 0; i < codes.length; i++) {
            posMap.set(codes[i].pos, i);
        }
        return posMap;
    }

    _isNamedExtCall(bc, resolver, name) {
        return this._isOpcode(bc, 'extcall', 'call_ext') && resolver(bc.obj, "handle") === name;
    }

    _identifyLoop(codes, startIndex, endIndex, resolver, posMap) {
        if (this._isRepeatWithIn(codes, startIndex, endIndex, resolver)) {
            return {
                tag: 'repeat_with_in',
                varSetIndex: startIndex + 5
            };
        }

        if (startIndex < 1) return null;

        let down = false;
        if (this._isOpcode(codes[startIndex - 1], 'lteq')) {
            down = false;
        } else if (this._isOpcode(codes[startIndex - 1], 'gteq')) {
            down = true;
        } else {
            return null;
        }

        const endRepeat = codes[endIndex - 1];
        const conditionStartIndex = posMap.get(endRepeat.pos - endRepeat.obj);
        if (conditionStartIndex === undefined || conditionStartIndex < 1) return null;

        const setBc = codes[conditionStartIndex - 1];
        const getBc = codes[conditionStartIndex];
        const incrementStart = endIndex - 5;
        if (incrementStart < 0) return null;

        const expected = this._getMatchingGetOpcode(setBc);
        if (!expected || !this._isOpcode(getBc, ...expected) || getBc.obj !== setBc.obj) {
            return null;
        }

        const incConst = codes[incrementStart];
        const incGet = codes[endIndex - 4];
        const incAdd = codes[endIndex - 3];
        const incSet = codes[endIndex - 2];

        if (!this._isIntLiteralOpcode(incConst, down ? -1 : 1)) return null;
        if (!this._isOpcode(incGet, ...expected) || incGet.obj !== setBc.obj) return null;
        if (!this._isOpcode(incAdd, 'add')) return null;
        if (!this._isOpcode(incSet, setBc.opcode) || incSet.obj !== setBc.obj) return null;

        return {
            tag: down ? 'repeat_with_down_to' : 'repeat_with_to',
            conditionSetIndex: conditionStartIndex - 1
        };
    }

    _isRepeatWithIn(codes, startIndex, endIndex, resolver) {
        if (startIndex < 7 || startIndex + 5 >= codes.length || endIndex < 3 || endIndex >= codes.length) {
            return false;
        }

        const before = [
            codes[startIndex - 7],
            codes[startIndex - 6],
            codes[startIndex - 5],
            codes[startIndex - 4],
            codes[startIndex - 3],
            codes[startIndex - 2],
            codes[startIndex - 1]
        ];
        const after = [
            codes[startIndex + 1],
            codes[startIndex + 2],
            codes[startIndex + 3],
            codes[startIndex + 4],
            codes[startIndex + 5]
        ];

        if (!this._isOpcode(before[0], 'peek') || before[0].obj !== 0) return false;
        if (!this._isOpcode(before[1], 'pusharglist', 'push_arg_list') || before[1].obj !== 1) return false;
        if (!this._isNamedExtCall(before[2], resolver, 'count')) return false;
        if (!this._isIntLiteralOpcode(before[3], 1)) return false;
        if (!this._isOpcode(before[4], 'peek') || before[4].obj !== 0) return false;
        if (!this._isOpcode(before[5], 'peek') || before[5].obj !== 2) return false;
        if (!this._isOpcode(before[6], 'lteq')) return false;

        if (!this._isOpcode(after[0], 'peek') || after[0].obj !== 2) return false;
        if (!this._isOpcode(after[1], 'peek') || after[1].obj !== 1) return false;
        if (!this._isOpcode(after[2], 'pusharglist', 'push_arg_list') || after[2].obj !== 2) return false;
        if (!this._isNamedExtCall(after[3], resolver, 'getAt')) return false;
        if (!this._isSetOpcode(after[4])) return false;

        if (!this._isIntLiteralOpcode(codes[endIndex - 3], 1)) return false;
        if (!this._isOpcode(codes[endIndex - 2], 'add')) return false;
        if (!this._isOpcode(codes[endIndex - 1], 'endrepeat')) return false;
        if (!this._isOpcode(codes[endIndex], 'pop') || codes[endIndex].obj !== 3) return false;

        return true;
    }

    _getMatchingGetOpcode(setBc) {
        if (!setBc) return null;
        switch (setBc.opcode) {
            case 'setglobal':
            case 'setglobal2':
                return ['getglobal', 'getglobal2', 'push_global'];
            case 'setprop':
            case 'set_prop':
                return ['getprop', 'push_prop'];
            case 'setparam':
            case 'set_param':
                return ['getparam', 'get_param'];
            case 'setlocal':
            case 'set_local':
                return ['getlocal', 'get_local'];
            default:
                return null;
        }
    }

    _isSetOpcode(bc) {
        return this._isOpcode(bc, 'setglobal', 'setglobal2', 'setprop', 'set_prop', 'setparam', 'set_param', 'setlocal', 'set_local');
    }

    _isIntLiteralOpcode(bc, value) {
        if (!bc) return false;
        if (this._isOpcode(bc, 'pushint8', 'push_int', 'pushint')) return bc.obj === value;
        if (value === 0 && this._isOpcode(bc, 'pushint0', 'push_0')) return true;
        if (value === 1 && this._isOpcode(bc, 'push_1')) return true;
        if (value === 2 && this._isOpcode(bc, 'push_2')) return true;
        return false;
    }

    _getLoopVarName(setBc, ctx) {
        if (!setBc) return 'i';
        switch (setBc.opcode) {
            case 'setglobal':
            case 'setglobal2':
                return ctx.resolver(setBc.obj, 'global');
            case 'setprop':
            case 'set_prop':
                return ctx.resolver(setBc.obj, 'handle');
            case 'setparam':
            case 'set_param':
                return ctx.handler.args[setBc.obj] || `a_${setBc.obj}`;
            case 'setlocal':
            case 'set_local':
                return ctx.handler.locals[setBc.obj] || `l_${setBc.obj}`;
            default:
                return 'i';
        }
    }

    _tagLoops(codes, resolver) {
        const posMap = this._getLoopPosMap(codes);

        for (let startIndex = 0; startIndex < codes.length; startIndex++) {
            const jmpIfZ = codes[startIndex];
            if (!this._isOpcode(jmpIfZ, 'jmpifz', 'jmp_if_z')) continue;

            const endPos = jmpIfZ.pos + jmpIfZ.obj;
            const endIndex = posMap.get(endPos);
            if (endIndex === undefined || endIndex < 1) continue;

            const endRepeat = codes[endIndex - 1];
            if (!this._isOpcode(endRepeat, 'endrepeat')) continue;
            if ((endRepeat.pos - endRepeat.obj) > jmpIfZ.pos) continue;

            const loopInfo = this._identifyLoop(codes, startIndex, endIndex, resolver, posMap);
            if (!loopInfo) {
                jmpIfZ.loopTag = 'repeat_while';
                continue;
            }

            jmpIfZ.loopTag = loopInfo.tag;
            jmpIfZ.loopInfo = loopInfo;

            if (loopInfo.tag === 'repeat_with_in') {
                for (let i = startIndex - 7; i <= startIndex - 1; i++) {
                    codes[i].loopTag = 'skip';
                }
                for (let i = startIndex + 1; i <= startIndex + 5; i++) {
                    codes[i].loopTag = 'skip';
                }
                codes[endIndex - 3].loopTag = 'skip';
                codes[endIndex - 2].loopTag = 'skip';
                codes[endIndex - 1].loopTag = 'skip';
                codes[endIndex].loopTag = 'skip';
            } else {
                const conditionSetIndex = loopInfo.conditionSetIndex;
                codes[conditionSetIndex].loopTag = 'skip';
                codes[conditionSetIndex + 1].loopTag = 'skip';
                codes[startIndex - 1].loopTag = 'skip';
                codes[endIndex - 5].loopTag = 'skip';
                codes[endIndex - 4].loopTag = 'skip';
                codes[endIndex - 3].loopTag = 'skip';
                codes[endIndex - 2].loopTag = 'skip';
                codes[endIndex - 1].loopTag = 'skip';
            }
        }
    }

    /**
     * Reconstructs a chunk reference (char, word, item, line) by popping 8 range values.
     */
    _readChunkRef(stack, base) {
        const lastLine = stack.pop();
        const firstLine = stack.pop();
        const lastItem = stack.pop();
        const firstItem = stack.pop();
        const lastWord = stack.pop();
        const firstWord = stack.pop();
        const lastChar = stack.pop();
        const firstChar = stack.pop();

        const isIntLiteral = (node, value) => node instanceof AST.IntLiteral && node.value === value;
        const applyChunk = (type, first, last, node) => {
            if (isIntLiteral(first, 0)) return node;
            if (isIntLiteral(first, -30000) && isIntLiteral(last, 0)) {
                return new AST.LastChunkExpression(type, node);
            }
            return new AST.ChunkExpression(type, first, last, node);
        };

        let node = base;
        node = applyChunk(4, firstLine, lastLine, node);
        node = applyChunk(3, firstItem, lastItem, node);
        node = applyChunk(2, firstWord, lastWord, node);
        node = applyChunk(1, firstChar, lastChar, node);

        return node;
    }

    /**
     * Phase 4: Translates a single bytecode into AST nodes.
     */
    _translate(bc, ctx) {
        const { stack, ast, resolver } = ctx;
        const op = bc.opcode;

        if (bc.loopTag === 'skip') {
            return;
        }

        switch (op) {
            case 'ret':
                let rv = stack.pop();
                // Allow void returns (stack underflows) anywhere - they're valid Lingo patterns
                if (rv && rv.constructor.name === 'ERROR') {
                    const last = (ast.currentBlock.statements.length > 0) ? ast.currentBlock.statements[ast.currentBlock.statements.length - 1] : null;
                    const isRet = last && (last.constructor.name === 'ReturnStatement' || (last.constructor.name === 'CallStatement' && last.name === 'return'));
                    if (!isRet) {
                        ast.addStatement(new AST.ReturnStatement(null));
                    }
                    break;
                }
                if (rv instanceof AST.ArgListLiteral) rv = (rv.value.length === 1) ? rv.value[0] : rv;
                const last = (ast.currentBlock.statements.length > 0) ? ast.currentBlock.statements[ast.currentBlock.statements.length - 1] : null;
                const isRet = last && (last.constructor.name === 'ReturnStatement' || (last.constructor.name === 'CallStatement' && last.name === 'return'));

                if (!isRet) {
                    ast.addStatement(new AST.ReturnStatement(rv));
                }
                break;

            case 'ret_factory': ast.addStatement(new AST.ExitStatement()); break;
            case 'pushint0': case 'push_0': stack.push(new AST.IntLiteral(0)); break;
            case 'push_1': stack.push(new AST.IntLiteral(1)); break;
            case 'push_2': stack.push(new AST.IntLiteral(2)); break;
            case (op.startsWith('pushint') ? op : null): stack.push(new AST.IntLiteral(bc.obj)); break;
            case 'push_int': stack.push(new AST.IntLiteral(bc.obj)); break;

            case 'pushcons': case 'push_const':
                stack.push(ctx.literals[bc.obj] || new AST.IntLiteral(bc.obj)); break;
            case 'pushsymb': case 'push_sym':
                stack.push(new AST.SymbolLiteral(resolver(bc.obj, "handle"))); break;
            case 'pushvarref': case 'push_var':
                stack.push(new AST.VarReference(resolver(bc.obj, "handle"))); break;
            case 'pushfloat32':
                stack.push(new AST.FloatLiteral(bc.obj)); break;
            case 'pushchunkvarref':
                stack.push(this._readVar(stack, bc.obj, resolver, ctx)); break;
            case 'getchunk':
                stack.push(this._readChunkRef(stack, stack.pop())); break;
            case 'putchunk': {
                const putType = (bc.obj >> 4) & 0x0f;
                const targetBase = this._readVar(stack, bc.obj & 0x0f, resolver, ctx);
                if (targetBase instanceof AST.ERROR) {
                    ast.addStatement(targetBase);
                    break;
                }
                const chunk = this._readChunkRef(stack, targetBase);
                const val = stack.pop();
                if (putType >= 0x01 && putType <= 0x03) {
                    ast.addStatement(new AST.PutStatement(putType, chunk, val));
                } else {
                    ast.addStatement(new AST.AssignmentStatement(chunk, val));
                }
                break;
            }
            case 'deletechunk': {
                const targetBase = this._readVar(stack, bc.obj, resolver, ctx);
                const target = this._readChunkRef(stack, targetBase);
                ast.addStatement(new AST.CallStatement("delete", target));
                break;
            }
            case 'hilitechunk': {
                const targetBase = this._readVar(stack, 0x06, resolver, ctx); // hilite defaults to fields
                const target = this._readChunkRef(stack, targetBase);
                ast.addStatement(new AST.CallStatement("hilite", target));
                break;
            }
            case 'getfield': {
                let fCast = null;
                if (ctx.sType >= 0x05) fCast = stack.pop();
                const fId = stack.pop();
                stack.push(new AST.MemberExpression("field", fId, fCast));
                break;
            }
            case 'put': {
                const putType = (bc.obj >> 4) & 0x0f;
                const target = this._readVar(stack, bc.obj & 0x0f, resolver, ctx);
                if (target instanceof AST.ERROR) {
                    ast.addStatement(target);
                    break;
                }
                const val = stack.pop();
                if (putType >= 0x01 && putType <= 0x03) {
                    ast.addStatement(new AST.PutStatement(putType, target, val));
                } else {
                    ast.addStatement(new AST.AssignmentStatement(target, val));
                }
                break;
            }
            case 'getglobal': case 'getglobal2': case 'push_global':
                stack.push(new AST.VarReference(resolver(bc.obj, "global"))); break;
            case 'getprop': case 'push_prop':
                stack.push(new AST.PropertyReference(resolver(bc.obj, "handle"))); break;
            case 'setglobal': case 'setglobal2':
                ast.addStatement(new AST.AssignmentStatement(new AST.VarReference(resolver(bc.obj, "global")), stack.pop())); break;

            case 'inv': stack.push(new AST.InverseOperator(stack.pop())); break;
            case 'not': stack.push(new AST.NotOperator(stack.pop())); break;

            case 'add': case 'sub': case 'mul': case 'div': case 'mod': case 'eq': case 'lt': case 'gt': case 'lteq': case 'gteq':
            case 'and': case 'or': case 'joinstr': case 'nteq': case 'containsstr': case 'joinpadstr':
                const right = stack.pop(), left = stack.pop();
                const map = { add: '+', sub: '-', mul: '*', div: '/', mod: 'mod', eq: '=', lt: '<', gt: '>', lteq: '<=', gteq: '>=', and: 'and', or: 'or', joinstr: '&', nteq: '<>', containsstr: 'contains', joinpadstr: '&&' };
                stack.push(new AST.BinaryOperator(map[op], left, right)); break;

            case 'getlocal': case 'get_local':
                stack.push(new AST.LocalVarReference(ctx.handler.locals[bc.obj] || `l_${bc.obj}`)); break;
            case 'setlocal': case 'set_local':
                ast.addStatement(new AST.AssignmentStatement(new AST.LocalVarReference(ctx.handler.locals[bc.obj] || `l_${bc.obj}`), stack.pop())); break;

            case 'getparam': case 'get_param': {
                // Bytecode param indices map directly to the args array after 'me' is re-injected
                // No offset needed because filtering and re-injecting restores original positions
                const node = new AST.ParamReference(ctx.handler.args[bc.obj] || `a_${bc.obj}`);
                stack.push(node);
                break;
            }
            case 'setparam': case 'set_param':
                ast.addStatement(new AST.AssignmentStatement(new AST.ParamReference(ctx.handler.args[bc.obj] || `a_${bc.obj}`), stack.pop())); break;

            case 'getprop':
                stack.push(new AST.PropertyReference(resolver(bc.obj, "handle"))); break;
            case 'setprop': case 'set_prop':
                const propName = resolver(bc.obj, "handle");
                if (propName !== 'pNoiseStripped') ast.addStatement(new AST.AssignmentStatement(new AST.PropertyReference(propName), stack.pop()));
                break;

            case 'getmovieprop':
                stack.push(new AST.TheExpression(resolver(bc.obj, "movie_prop"))); break;

            case 'gettoplevelprop':
                stack.push(new AST.VarReference(resolver(bc.obj, "global_prop"))); break;

            case 'setmovieprop':
                ast.addStatement(new AST.AssignmentStatement(new AST.TheExpression(resolver(bc.obj, "movie_prop")), stack.pop())); break;

            case 'thebuiltin': {
                // Built-in function call - args are already on stack as arglist
                const builtinArgs = stack.pop();
                const builtinName = resolver(bc.obj, "handle");
                stack.push(new AST.CallStatement(builtinName, builtinArgs));
                break;
            }

            case 'localcall': case 'extcall': case 'tellcall': case 'call': case 'call_ext': {
                let callFn, callArgs = stack.pop();
                if (op === 'localcall') {
                    const targetHandler = ctx.handlers[bc.obj];
                    callFn = targetHandler ? resolver(targetHandler.nameId, "handle") : `handler_${bc.obj}`;
                } else {
                    callFn = resolver(bc.obj, "handle");
                }

                let isDuplicateReturn = false;
                if (callFn === 'return') {
                    const stmts = ast.currentBlock.statements;
                    const last = stmts.length > 0 ? stmts[stmts.length - 1] : null;
                    if (last && (last.constructor.name === 'ReturnStatement' || (last.constructor.name === 'CallStatement' && last.name === 'return'))) {
                        isDuplicateReturn = true;
                    }
                }
                if (!isDuplicateReturn) {
                    const callExpr = new AST.CallStatement(callFn, callArgs);

                    // HABBO ORIGINS: Try/Catch transformation
                    if (callFn === 'try' && callArgs instanceof AST.ArgListLiteral && callArgs.noRet && callArgs.value.length === 0) {
                        const tryNode = new AST.TryStatement();
                        ast.addStatement(tryNode);
                        ast.enterBlock(tryNode.tryBlock);
                        return; // No need to push to stack
                    }

                    // Check if the arglist was created with pusharglistnoret
                    if (callArgs?.noRet) {
                        ast.addStatement(callExpr);
                    } else {
                        stack.push(callExpr);
                    }
                }
            }
                break;

            case 'pusharglist': case 'push_arg_list':
            case 'pusharglistnoret': case 'push_arg_list_no_ret': {
                const count = bc.obj;
                const onStack = (stack.length > count);
                const noRet = op.includes('noret');
                this.log(
                    'DEBUG',
                    `[LingoDecompiler] Stack before pusharglist(${count}, ${noRet}): ${stack._items.map(s => (s ? s.toString().substring(0, 30) : 'null')).join(', ')}`
                );
                const argsArr = stack.splice(Math.max(0, stack.length - count), count);
                const argList = new AST.ArgListLiteral(argsArr);
                argList.targetOnStack = onStack;
                argList.noRet = noRet;
                stack.push(argList);
                break;
            }

            case 'pushlist': case 'push_list':
                const listArgs = stack.pop();
                stack.push(new AST.ListLiteral(listArgs instanceof AST.ArgListLiteral ? listArgs.value : (listArgs ? [listArgs] : []))); break;

            case 'pushproplist': case 'push_prop_list':
                const propArgs = stack.pop();
                stack.push(new AST.PropListLiteral(propArgs instanceof AST.ArgListLiteral ? propArgs.value : (propArgs ? [propArgs] : []))); break;

            case 'get': case 'set': {
                const propertyID = stack.pop();
                const propertyType = bc.obj;
                const propVal = (propertyID instanceof AST.Literal) ? propertyID.value : propertyID;
                const v4ref = this._readV4Property(propertyType, propVal, ctx);

                if (op === 'get') {
                    stack.push(v4ref);
                } else {
                    const val = stack.pop();
                    ast.addStatement(new AST.AssignmentStatement(v4ref, val));
                }
                break;
            }

            case 'objcall': case 'obj_call': case 'call_obj': case 'objcallv4': {
                let callArgs = stack.pop();
                let oMethod = resolver(bc.obj, "handle");
                let oVals = (callArgs instanceof AST.ArgListLiteral) ? [...callArgs.value] : (callArgs ? [callArgs] : []);
                let oTarget;

                if (op === 'objcallv4') {
                    oTarget = new AST.VarReference(resolver(bc.obj, "handle"));
                } else if (oVals.length > 0) {
                    oTarget = oVals.shift();
                } else if (callArgs instanceof AST.ArgListLiteral && callArgs.targetOnStack && stack.length > 0 && !stack.peek().isStatement) {
                    // Some handlers leave an earlier stack value around for a following opcode
                    // like setobjprop; only consume it as a receiver when the arg list itself
                    // does not provide one.
                    oTarget = stack.pop();
                } else {
                    oTarget = new AST.ERROR("Missing Object Target");
                }

                if (op === 'objcall' && oVals.length === 0 && oTarget instanceof AST.ERROR) break;

                let objCallNode;
                // Special cases for common Lingo methods
                if (oMethod === 'count' && oVals.length === 1 && this._isSymbolLiteral(oVals[0])) {
                    const propRef = oVals[0].value;
                    objCallNode = new AST.BinaryOperator('.', oTarget, new AST.VarReference(propRef + '.count'));
                } else if ((oMethod === 'getProp' || oMethod === 'getPropRef') && oVals.length === 1 && this._isSymbolLiteral(oVals[0])) {
                    objCallNode = this._buildPropertyAccess(oTarget, oVals[0]);
                } else if (oMethod === 'getAt' && oVals.length === 1) {
                    objCallNode = new AST.BinaryOperator('[]', oTarget, oVals[0]);
                } else if (oMethod === 'setAt' && oVals.length === 2) {
                    objCallNode = new AST.AssignmentStatement(
                        new AST.BinaryOperator('[]', oTarget, oVals[0]),
                        oVals[1]
                    );
                } else if ((oMethod === 'getProp' || oMethod === 'getPropRef') && (oVals.length === 2 || oVals.length === 3) && this._isSymbolLiteral(oVals[0])) {
                    const propExpr = this._buildPropertyAccess(oTarget, oVals[0]);
                    objCallNode = this._buildIndexedAccess(propExpr, oVals[1], oVals[2] || null);
                } else if (oMethod === 'setProp' && (oVals.length === 3 || oVals.length === 4) && this._isSymbolLiteral(oVals[0])) {
                    const propExpr = this._buildPropertyAccess(oTarget, oVals[0]);
                    const valueExpr = oVals[oVals.length - 1];
                    const targetExpr = this._buildIndexedAccess(propExpr, oVals[1], oVals.length === 4 ? oVals[2] : null);
                    objCallNode = new AST.AssignmentStatement(targetExpr, valueExpr);
                } else {
                    objCallNode = new AST.ObjCallStatement(oTarget, oMethod, new AST.ArgListLiteral(oVals));
                }

                if (objCallNode?.isStatement) {
                    ast.addStatement(objCallNode);
                } else if (callArgs?.noRet) {
                    objCallNode.isStatement = true;
                    ast.addStatement(objCallNode);
                } else {
                    stack.push(objCallNode);
                }
                break;
            }


            case 'getobjprop': case 'get_prop_obj': case 'getchainedprop': {
                const objP = stack.pop();
                const propId = resolver(bc.obj, "handle");
                if (objP) {
                    stack.push(new AST.ObjectPropertyExpression(objP, propId));
                } else {
                    stack.push(new AST.TheExpression(propId));
                }
                break;
            }

            case 'setobjprop': case 'set_prop_obj':
                const valS = stack.pop(), objS = stack.pop(), sPropId = resolver(bc.obj, "handle");
                if (objS) {
                    ast.addStatement(new AST.AssignmentStatement(new AST.ObjectPropertyExpression(objS, sPropId), valS));
                } else {
                    ast.addStatement(new AST.AssignmentStatement(new AST.TheExpression(sPropId), valS));
                }
                break;

            case 'pop':
                const poppedPop = stack.pop();
                if (poppedPop instanceof AST.CallStatement || poppedPop instanceof AST.ObjCallStatement) {
                    ast.addStatement(poppedPop);
                }
                break;

            case 'jmpifz': case 'jmp_if_z': {
                const blockEnd = bc.pos + bc.obj;

                if (bc.loopTag === 'repeat_with_in') {
                    const listExpr = stack.pop();
                    const varName = this._getLoopVarName(ctx.codes[bc.loopInfo.varSetIndex], ctx);
                    const repeatNode = new AST.RepeatWithInStatement(varName, listExpr);
                    repeatNode.block.endPos = blockEnd;
                    ast.addStatement(repeatNode);
                    ast.enterBlock(repeatNode.block);
                    break;
                }

                if (bc.loopTag === 'repeat_with_to' || bc.loopTag === 'repeat_with_down_to') {
                    const endExpr = stack.pop();
                    const startExpr = stack.pop();
                    const varName = this._getLoopVarName(ctx.codes[bc.loopInfo.conditionSetIndex], ctx);
                    const repeatNode = new AST.RepeatWithStatement(
                        varName,
                        startExpr,
                        endExpr,
                        bc.loopTag === 'repeat_with_down_to'
                    );
                    repeatNode.block.endPos = blockEnd;
                    ast.addStatement(repeatNode);
                    ast.enterBlock(repeatNode.block);
                    break;
                }

                const condVal = stack.pop();

                // HABBO ORIGINS: Catch transformation
                // Detect 'if catch() then'
                const isCatchCond = (condVal instanceof AST.CallStatement && condVal.name === 'catch') ||
                                    (condVal instanceof AST.NotOperator && condVal.expr instanceof AST.CallStatement && condVal.expr.name === 'catch');

                if (isCatchCond && ast.currentBlock.parent instanceof AST.TryStatement) {
                    const tryNode = ast.currentBlock.parent;
                    ast.exitBlock(); // Exit tryBlock
                    tryNode.catchBlock.endPos = blockEnd;
                    ast.enterBlock(tryNode.catchBlock);
                    break;
                }

                if (ctx.activeCase &&
                    condVal instanceof AST.BinaryOperator &&
                    condVal.op === '=' &&
                    this._sameNode(condVal.left, ctx.activeCase.expr)) {
                    const branch = new AST.CaseBranch([condVal.right]);
                    branch.block.endPos = blockEnd;
                    ctx.activeCase.addBranch(branch);
                    ast.enterBlock(branch.block);
                } else {
                    const isRepeatWhile = bc.loopTag === 'repeat_while';

                    if (isRepeatWhile) {
                        const repeatNode = new AST.RepeatWhileStatement(condVal);
                        repeatNode.block.endPos = blockEnd;
                        ast.addStatement(repeatNode);
                        ast.enterBlock(repeatNode.block);
                    } else {
                        const ifNode = new AST.IfStatement(0, condVal);
                        ifNode.block1.endPos = blockEnd;
                        ast.addStatement(ifNode);
                        ast.enterBlock(ifNode.block1);
                    }
                }
                break;
            }

            case 'jmp':
                const jumpTarget = bc.pos + bc.obj, nextBc = ctx.codes[ctx.index + 1];

                let inLoop = false;
                let currNode = ast.currentBlock;
                while (currNode) {
                    if (currNode.parent instanceof AST.RepeatWhileStatement
                        || currNode.parent instanceof AST.RepeatWithStatement
                        || currNode.parent instanceof AST.RepeatWithInStatement) {
                        if (jumpTarget >= currNode.parent.block.endPos) {
                            inLoop = true;
                            break;
                        }
                    }
                    currNode = currNode.parent ? currNode.parent.parent : null;
                }

                if (inLoop) {
                    ast.addStatement(new AST.ExitRepeatStatement());
                    break;
                }

                if (ast.currentBlock.parent instanceof AST.IfStatement) {
                    const si = ast.currentBlock.parent;
                    if (nextBc && nextBc.pos === ast.currentBlock.endPos) {
                        si.setType(1);
                        si.block2.endPos = jumpTarget;
                        ast.exitBlock(); // exit block1
                        ast.enterBlock(si.block2); // enter block2
                    }
                } else if (ast.currentBlock.parent instanceof AST.CaseBranch) {
                    const branch = ast.currentBlock.parent;
                    const caseStmt = branch.parent;
                    if (caseStmt instanceof AST.CaseStatement) {
                        caseStmt.finalPos = Math.max(caseStmt.finalPos || 0, jumpTarget);
                    }
                }
                break;

            case 'peek':
                {
                const depth = Number.isInteger(bc.obj) ? bc.obj : 0;
                const idx = stack.length - 1 - depth;
                const valPeek = idx >= 0
                    ? stack._items[idx]
                    : ((depth === 0 && ctx.activeCase) ? ctx.activeCase.expr : new AST.ERROR("Stack Underflow"));
                stack.push(valPeek);

                if (depth === 0 && !ctx.activeCase && ctx.index + 3 < ctx.codes.length) {
                    const n1 = ctx.codes[ctx.index + 1], n2 = ctx.codes[ctx.index + 2], n3 = ctx.codes[ctx.index + 3];
                    if (n1.opcode.startsWith('push') && n2.opcode === 'eq' && n3.opcode === 'jmpifz') {
                        ctx.activeCase = new AST.CaseStatement(valPeek);
                        ctx.activeCase.finalPos = -1;
                        ast.addStatement(ctx.activeCase);
                    }
                }
                break;
                }

            case 'endrepeat':
                // endrepeat jumps back to the loop condition; the block exit is handled
                // by the position-based block closing logic in the main loop.
                break;

            case 'newobj':
                const nArgs = stack.pop(), nVals = (nArgs instanceof AST.ArgListLiteral) ? [...nArgs.value] : (nArgs ? [nArgs] : []);
                stack.push(new AST.CallStatement('new', new AST.ArgListLiteral([new AST.VarReference(resolver(bc.obj, "handle")), ...nVals]))); break;
        }
    }
}

module.exports = LingoDecompiler;
