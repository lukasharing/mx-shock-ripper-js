/**
 * @version 1.3.0
 * LingoDecompiler.js
 * 
 * High-performance Lingo bytecode decompiler using a multi-phase 
 * control flow reconstruction and statement recovery algorithm.
 * 
 * See docs/doc/05_LingoDecompiler.md for technical details.
 * Ported from ProjectorRaysJS.
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
    constructor(logger) { this.log = logger || console.log; }

    /**
     * Main entry point for decompiling a Lingo script.
     * @param {Buffer} lscrData - Raw Lscr chunk data.
     * @param {string[]} nameTable - Parsed symbol names from Lnam.
     * @param {number} externalScriptType - Fallback script type if header is empty.
     * @param {number} memberId - For logging/debugging.
     * @param {object} options - Options (e.g., { lasm: true }).
     */
    decompile(lscrData, nameTable, externalScriptType = 0, memberId = 0, options = {}) {
        try {
            if (lscrData.length < 132) {
                return options.lasm ? { source: "-- Script buffer too small/encrypted", lasm: "" } : "-- Script buffer too small/encrypted";
            }
            const stream = new DataStream(lscrData, 'big');
            const { hLen, sType, map } = this._getSchema(lscrData, externalScriptType);
            const cal = this._getCalibration(lscrData, nameTable, map, hLen, sType);

            /**
             * Resolves a bytecode ID to a name based on the calibrated shift.
             */
            const getName = (id, type) => {
                if (!nameTable || nameTable.length === 0) return type.includes("prop") ? `p_${id}` : `n_${id}`;
                let shift = cal.hShift;
                if (type === "global_prop") shift = cal.gShift;
                else if (type === "movie_prop") shift = cal.mShift;

                const N = nameTable.length;
                const idx = (id - shift + (N * 50)) % N;
                let name = nameTable[idx] || `u_${id}`;

                // Common obfuscation overrides / hardcoded properties
                if (id === LingoConfig.SPECIAL_IDS.TRACE_SCRIPT) name = 'traceScript';
                if (id === LingoConfig.SPECIAL_IDS.PLAYER) name = '_player';
                if (id === LingoConfig.SPECIAL_IDS.MOVIE) name = '_movie';
                if (id === LingoConfig.SPECIAL_IDS.TYPE) name = 'type';
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
                const stack = new LingoStack();
                const ast = new ASTWrapper(new AST.Handler(hName, args));

                const localInfo = this._getSymbols(stream, handler.lCnt, handler.lOff, getName);
                const locals = localInfo.symbols || localInfo;
                const context = {
                    stack, ast, resolver: getName,
                    handler: { locals, args, name: hName, meWasFiltered },
                    literals: literals,
                    isV4: (hLen === LingoConfig.V4_HLEN),
                    codes, index: 0, memberId,
                    handlers: handlers
                };






                // Sequential instruction processing
                for (let i = 0; i < codes.length; i++) {
                    const bc = codes[i];

                    // Close control flow blocks if jump target reached
                    while (ast.currentBlock.endPos > 0 && bc.pos >= ast.currentBlock.endPos) {
                        ast.exitBlock();
                    }

                    // Detection for 'otherwise' branch
                    if (context.activeCase && !context.activeCase.isOtherwiseActive) {
                        // Enter otherwise if we are no longer in a branch block and not at a new peek/eq
                        if (ast.currentBlock.parent === ast.root && bc.opcode !== 'peek' && bc.opcode !== 'pop' && context.activeCase.finalPos > 0 && bc.pos < context.activeCase.finalPos) {
                            const otherwise = new AST.CaseBranch([]);
                            otherwise.block.endPos = context.activeCase.finalPos;
                            context.activeCase.addBranch(otherwise);
                            context.activeCase.isOtherwiseActive = true;
                            ast.enterBlock(otherwise.block);
                        }
                    }

                    // Special case for ending an 'otherwise' block or CaseStatement
                    if (context.activeCase && context.activeCase.finalPos > 0 && bc.pos >= context.activeCase.finalPos) {
                        context.activeCase = null;
                    }

                    context.index = i;
                    try {
                        this._translate(bc, context);
                    } catch (e) {
                        // Skip corrupted/unrecognized instructions
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
    _getCalibration(data, names, map, hLen, sType) {
        let hShift = 0, gShift = 0, mShift = 0;
        const info = map.get('HAND');

        if (names && names.length > 0 && info) {
            const ds = new DataStream(data, 'big');
            ds.seek(info.offset);
            const firstId = ds.readUint16();

            // Probe 1: Handler Shift
            const nIdx = names.indexOf("new");
            const cIdx = names.indexOf("construct");







            if (firstId === nIdx || firstId === cIdx) {
                hShift = 0;
            } else if ([LingoConfig.SCRIPT_TYPE.CAST, LingoConfig.SCRIPT_TYPE.LEGACY_BEHAVIOR, LingoConfig.SCRIPT_TYPE.LEGACY_CAST].includes(sType)) {
                if (nIdx !== -1) hShift = (firstId - nIdx + names.length) % names.length;
                else if (cIdx !== -1) hShift = (firstId - cIdx + names.length) % names.length;
            } else {
                hShift = 0;
            }

            // Probe 2: Movie/Global Shift using 'traceScript'
            const tIdx = names.indexOf("traceScript");
            if (tIdx !== -1) {
                ds.seek(info.offset); ds.skip(4);
                const co = ds.readUint32();
                if (co > 0 && co < data.length) {
                    let pos = co, max = Math.min(co + 1000, data.length);
                    while (pos < max - 2) {
                        const op = data[pos];
                        const idx = (op >= LingoConfig.OP_SHIFT_THRESHOLD) ? op % LingoConfig.OP_SHIFT_THRESHOLD : op;
                        let len = (op >= 0xc0) ? 5 : (op >= 0x80) ? 3 : (op >= LingoConfig.OP_SHIFT_THRESHOLD) ? 2 : 1;
                        if (len > 1 && (pos + 1 + 2 <= data.length)) {
                            const id = data.readUInt16BE(pos + 1);
                            // Detect GETTOPLEVELPROP (0x32) or MOVIEPROP/PUSHVAR (0x1f/0x20)
                            if ([0x1f, 0x20].includes(idx)) {
                                if (mShift === 0) mShift = (id - tIdx + names.length) % names.length;
                            } else if (idx === 0x32) {
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
            case LingoConfig.LITERAL_TYPE.FLOAT: stream.readUint32(); return new AST.FloatLiteral(stream.readDouble());
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
                obj = (idx === 0x6f) ? stream.readInt32() : stream.readUint32();
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
     * Phase 4: Translates a single bytecode into AST nodes.
     */
    _translate(bc, ctx) {
        const { stack, ast, resolver } = ctx;
        const op = bc.opcode;

        switch (op) {
            case 'ret':
                let rv = stack.pop();
                if (rv instanceof AST.ArgListLiteral) rv = (rv.value.length === 1) ? rv.value[0] : rv;
                if (rv?.toString() === '0' && ctx.index >= ctx.codes.length - 2) return;
                const last = ast.currentBlock.statements[ast.currentBlock.statements.length - 1];
                if (!(last instanceof AST.ReturnStatement)) {
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
            case 'push_global':
                stack.push(new AST.VarReference(resolver(bc.obj, "global"))); break;
            case 'push_prop':
                stack.push(new AST.PropertyReference(resolver(bc.obj, "handle"))); break;

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

            case 'getmovieprop': case 'gettoplevelprop':
                const globName = resolver(bc.obj, op.includes("movie") ? "movie_prop" : "global_prop");
                const globPath = ['_movie', '_player', '_system', 'traceScript', 'mouseLoc'].includes(globName) ? (op.includes("movie") ? '_movie.' : 'the ') + globName : 'the ' + globName;
                stack.push(new AST.VarReference(globPath)); break;

            case 'setmovieprop':
                const sName = resolver(bc.obj, "movie_prop"), sPath = ['_player', '_system', 'traceScript'].includes(sName) ? '_movie.' + sName : 'the ' + sName;
                ast.addStatement(new AST.AssignmentStatement(new AST.VarReference(sPath), stack.pop())); break;

            case 'localcall': case 'extcall': case 'tellcall': case 'call': case 'call_ext':
                let callFn, callArgs = stack.pop();
                if (op === 'localcall') {
                    const targetIdx = ctx.handlers[bc.obj];
                    callFn = targetIdx ? resolver(targetIdx.nameId, "handle") : `h_${bc.obj}`;
                } else {
                    callFn = resolver(bc.obj, "handle");
                }

                if ((op === 'extcall' || op === 'call_ext') && bc.obj === LingoConfig.SPECIAL_IDS.EXT_CALL_MAGIC) {
                    let resVal = (callArgs instanceof AST.ArgListLiteral && callArgs.value.length === 1) ? callArgs.value[0] : callArgs;
                    ast.addStatement(new AST.ReturnStatement(resVal));
                } else if (['me', 'constant', 'return'].includes(callFn)) {
                    let resVal = (callArgs instanceof AST.ArgListLiteral && callArgs.value.length === 1) ? callArgs.value[0] : callArgs;
                    stack.push(resVal);
                } else if (callFn === 'void') {
                    stack.push(new AST.VarReference('VOID'));
                } else {
                    const callStmt = new AST.CallStatement(callFn, callArgs);
                    if (callArgs?.noRet) ast.addStatement(callStmt);
                    else stack.push(callStmt);
                }
                break;

            case 'pusharglist': case 'pusharglistnoret': case 'push_arg_list':
                const argsArr = stack.splice(Math.max(0, stack.length - bc.obj), bc.obj);
                const argList = new AST.ArgListLiteral(argsArr);
                if (op.includes('noret')) argList.noRet = true;
                stack.push(argList); break;

            case 'pop':
                const poppedPop = stack.pop();
                if (poppedPop?.toString()?.includes('(')) ast.addStatement(poppedPop);
                break;

            case 'pushlist': case 'push_list':
                const listArgs = stack.pop();
                stack.push(new AST.ListLiteral(listArgs instanceof AST.ArgListLiteral ? listArgs.value : (listArgs ? [listArgs] : []))); break;

            case 'pushproplist': case 'push_prop_list':
                const propArgs = stack.pop();
                stack.push(new AST.PropListLiteral(propArgs instanceof AST.ArgListLiteral ? propArgs.value : (propArgs ? [propArgs] : []))); break;

            case 'get': case 'set':
                const invId = bc.obj & 0x3f;
                const v4ref = LingoConfig.V4_SPRITE_PROPS[invId] ? new AST.VarReference('the ' + LingoConfig.V4_SPRITE_PROPS[invId]) : new AST.VarReference(`v4_${invId}`);
                if (op === 'get') stack.push(v4ref); else ast.addStatement(new AST.AssignmentStatement(v4ref, stack.pop())); break;

            case 'objcall': case 'objcallv4': case 'call_obj':
                const oArgs = stack.pop(), oVals = (oArgs instanceof AST.ArgListLiteral) ? [...oArgs.value] : (oArgs ? [oArgs] : []);
                if (op === 'objcall' && oVals.length === 0) break;
                const oTarget = (op === 'objcall' || op === 'call_obj') ? oVals.shift() : new AST.VarReference(resolver(bc.obj, "handle"));
                const oMethod = resolver(bc.obj, "handle");

                let objCallNode;
                if (oMethod === 'count' && oVals.length === 1 && oVals[0] instanceof AST.VarReference) {
                    objCallNode = new AST.BinaryOperator('.', oVals[0], new AST.VarReference('count'));
                } else if (oMethod === 'getProp' && oVals.length === 2) {
                    objCallNode = new AST.BinaryOperator('.', oVals[0], new AST.VarReference(oVals[1].toString().replace(/^#/, '')));
                } else if (oMethod === 'getAt' && oVals.length === 1) {
                    objCallNode = new AST.BinaryOperator('[]', oTarget, oVals[0]);
                } else {
                    objCallNode = new AST.ObjCallStatement(oTarget, oMethod, new AST.ArgListLiteral(oVals));
                }

                if (oArgs?.noRet) ast.addStatement(objCallNode);
                else stack.push(objCallNode);
                break;

            case 'getobjprop': case 'get_prop_obj': {
                const objP = stack.pop(), propId = resolver(bc.obj, "handle");
                if (objP) stack.push(new AST.BinaryOperator('.', objP, new AST.VarReference(propId))); break;
            }

            case 'setobjprop': case 'set_prop_obj':
                const setV = stack.pop(), setO = stack.pop();
                if (setO) {
                    const setPropName = resolver(bc.obj, "handle");
                    if (setPropName === 'traceScript') {
                        ast.addStatement(new AST.AssignmentStatement(new AST.PropertyReference("the traceScript"), setV));
                    } else if (setO instanceof AST.VarReference && ['the traceScript', '_player', '_movie'].some(k => setO.toString().includes(k))) {
                        ast.addStatement(new AST.AssignmentStatement(setO, setV));
                    } else {
                        ast.addStatement(new AST.AssignmentStatement(new AST.BinaryOperator('.', setO, new AST.VarReference(setPropName)), setV));
                    }
                } break;

            case 'jmpifz': case 'jmp_if_z':
                const blockEnd = bc.pos + bc.len + bc.obj, condVal = stack.pop();
                if (ctx.activeCase && condVal instanceof AST.BinaryOperator && condVal.op === '=') {
                    const branch = new AST.CaseBranch([condVal.right]);
                    branch.block.endPos = blockEnd;
                    ctx.activeCase.addBranch(branch);
                    ast.enterBlock(branch.block);
                } else {
                    const ifNode = new AST.IfStatement(0, condVal);
                    ifNode.block1.endPos = blockEnd;
                    ast.addStatement(ifNode);
                    ast.enterBlock(ifNode.block1);
                }
                break;

            case 'jmp':
                const jumpTarget = bc.pos + bc.len + bc.obj, nextBc = ctx.codes[ctx.index + 1];
                if (ast.currentBlock.parent instanceof AST.IfStatement) {
                    const si = ast.currentBlock.parent;
                    if (nextBc && nextBc.pos === ast.currentBlock.endPos) {
                        si.setType(1);
                        si.block2.endPos = jumpTarget;
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
                const valPeek = stack.peek();
                stack.push(valPeek);

                if (!ctx.activeCase && ctx.index + 3 < ctx.codes.length) {
                    const n1 = ctx.codes[ctx.index + 1], n2 = ctx.codes[ctx.index + 2], n3 = ctx.codes[ctx.index + 3];
                    if (n1.opcode.startsWith('push') && n2.opcode === 'eq' && n3.opcode === 'jmpifz') {
                        ctx.activeCase = new AST.CaseStatement(valPeek);
                        ctx.activeCase.finalPos = -1;
                        ast.addStatement(ctx.activeCase);
                    }
                }
                break;

            case 'newobj':
                const nArgs = stack.pop(), nVals = (nArgs instanceof AST.ArgListLiteral) ? [...nArgs.value] : (nArgs ? [nArgs] : []);
                stack.push(new AST.CallStatement('new', new AST.ArgListLiteral([new AST.VarReference(resolver(bc.obj, "handle")), ...nVals]))); break;
        }
    }
}

module.exports = LingoDecompiler;
