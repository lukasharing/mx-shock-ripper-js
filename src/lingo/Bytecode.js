/**
 * @version 1.1.1
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
        const end = offset + length;

        while (p < end && p < buffer.length) {
            const pos = p;
            const op = buffer[p++];
            let obj = 0, objLen = 0;

            if (op >= LingoConfig.OP_SHIFT_THRESHOLD) {
                // Determine object size and signedness
                if (op >= 0xC0) {
                    obj = (op === 0xEF) ? buffer.readInt32BE(p) : buffer.readUInt32BE(p);
                    objLen = 4; p += 4;
                } else if (op >= 0x80) {
                    // Some 3-byte ops are signed (jumps, etc)
                    const subOp = op % LingoConfig.OP_SHIFT_THRESHOLD;
                    obj = [0x13, 0x14, 0x15, 0x2e].includes(subOp) ? buffer.readInt16BE(p) : buffer.readUInt16BE(p);
                    objLen = 2; p += 2;
                } else {
                    const subOp = op % LingoConfig.OP_SHIFT_THRESHOLD;
                    obj = [0x13, 0x14, 0x15].includes(subOp) ? buffer.readInt8(p) : buffer[p];
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
