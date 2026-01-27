/**
 * @version 1.1.9
 * Bytecode.js
 * 
 * Translates raw numeric opcodes into human-readable instruction mnemonics.
 */

const { LingoConfig, LingoOpcode } = require('../Constants');

class Bytecode {
    /**
     * @param {number} val - Raw opcode byte value.
     * @param {number} obj - The operand (argument) for the opcode.
     * @param {number} objLength - Length of the operand in bytes.
     * @param {number} pos - Absolute byte position in the script data.
     */
    constructor(val, obj, objLength, pos) {
        this.val = val;
        this.obj = obj;
        this.objLength = objLength;
        this.pos = pos;
        this.len = 1 + objLength; // Total instruction length
        this.opcode = this.getOpcode(this.val);
        this.translation = null; // High-level AST node eventually mapped to this bytecode
    }

    /**
     * Translates a raw byte value into a Lingo opcode mnemonic.
     */
    getOpcode(val) {
        let opcode;
        if (val < LingoConfig.OP_SHIFT_THRESHOLD) {
            opcode = LingoOpcode.ONE_BYTE_CODES[val];
        } else {
            // Apply MOD 0x40 shift for multi-byte opcodes
            opcode = LingoOpcode.MULTI_BYTE_CODES[val % LingoConfig.OP_SHIFT_THRESHOLD];
        }

        return opcode || `unk_0x${val.toString(16)}`;
    }
}

module.exports = Bytecode;
