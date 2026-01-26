/**
 * @version 1.1.4
 * Bytecode.js - Lingo bytecode decoding and mnemonic mapping
 * 
 * Responsible for translating raw binary opcodes into human-readable mnemonics 
 * based on the Adobe Director 4.x - MX bytecode specifications.
 */

const { LingoConfig, LingoOpcode } = require('../Constants');
const { ONE_BYTE_CODES, MULTI_BYTE_CODES } = LingoOpcode;

class Bytecode {
    /**
     * static parse() - High-level scanner for converting a raw buffer into an array of Bytecode objects.
     */
    static parse(buffer, offset, length, literals = [], resolveName = null) {
        const results = [];
        let p = offset;
        const end = Math.min(offset + length, buffer.length);

        while (p < end) {
            const pos = p;
            const op = buffer[p++];
            let obj = 0, objLen = 0;

            if (op >= LingoConfig.OP_SHIFT_THRESHOLD) {
                const idx = op >= 0x80 ? LingoConfig.OP_SHIFT_THRESHOLD + (op % LingoConfig.OP_SHIFT_THRESHOLD) : op;

                if (op >= 0xC0) {
                    if (p + 4 > end) break;
                    obj = (idx === 0x6f) ? buffer.readInt32BE(p) : buffer.readUInt32BE(p);
                    objLen = 4; p += 4;
                } else if (op >= 0x80) {
                    if (p + 2 > end) break;
                    // Fixed signed/unsigned detection for 3-byte opcodes
                    const isSigned = [0x41, 0x6e, 0x53, 0x54, 0x55, 0x56, 0x6f].includes(idx);
                    obj = isSigned ? buffer.readInt16BE(p) : buffer.readUInt16BE(p);
                    objLen = 2; p += 2;
                } else {
                    if (p + 1 > end) break;
                    obj = (idx === 0x41) ? buffer.readInt8(p) : buffer.readUInt8(p);
                    objLen = 1; p++;
                }
            }

            results.push(new Bytecode(op, obj, objLen, pos, literals, resolveName));
        }
        return results;
    }

    constructor(val, obj, objLength, pos, literals = [], resolveName = null) {
        this.val = val;
        this.obj = obj;
        this.pos = pos;
        this.len = 1 + objLength;
        this.opcode = this.getMnemonic(val);
        this.literal = (this.opcode === "pushcons") ? literals[obj] : null;
        this.resolvedName = (resolveName && ["getprop", "setprop", "extcall", "objcall", "objcallv4"].includes(this.opcode)) ? resolveName(obj, 'prop') : null;
    }

    getMnemonic(val) {
        if (val < LingoConfig.OP_SHIFT_THRESHOLD) return ONE_BYTE_CODES[val] || `unk_0x${val.toString(16)}`;
        return MULTI_BYTE_CODES[val % LingoConfig.OP_SHIFT_THRESHOLD] || `ext_0x${val.toString(16)}`;
    }
}

module.exports = Bytecode;
