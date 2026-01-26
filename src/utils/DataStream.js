/**
 * @version 1.1.6
 * DataStream.js - High-performance binary abstraction for Adobe Director assets
 * 
 * Provides a stateful wrapper over Node.js Buffers with support for runtime 
 * endianness switching (crucial for RIFX/XFIR compatibility) and specialized 
 * Director primitives like VarInt and FourCC.
 */

class DataStream {
    /**
     * @param {Buffer} buffer - The underlying data source
     * @param {string} endianness - Initial byte order ('big' or 'little')
     */
    constructor(buffer, endianness = 'big') {
        this.buffer = buffer;
        this.position = 0;
        this.endianness = endianness;
    }

    /**
     * Absolute move of the stream pointer.
     * @param {number} pos 
     */
    seek(pos) {
        this.position = pos;
    }

    /**
     * Relative move of the stream pointer.
     * @param {number} n 
     */
    skip(n) {
        this.position += n;
    }

    /**
     * Extracts a sub-buffer without copying.
     * @param {number} length 
     * @returns {Buffer}
     */
    readBytes(length) {
        if (this.position + length > this.buffer.length) {
            throw new Error(`Read out of range: pos=${this.position} len=${length} buffer=${this.buffer.length}`);
        }
        const result = this.buffer.slice(this.position, this.position + length);
        this.position += length;
        return result;
    }

    /**
     * Standard integer readers with endianness resolution.
     */
    readUint8() {
        if (this.position >= this.buffer.length) {
            throw new Error(`Read out of range (Uint8) at pos ${this.position} (buffer: ${this.buffer.length})`);
        }
        return this.buffer.readUInt8(this.position++);
    }

    readInt8() {
        if (this.position >= this.buffer.length) {
            throw new Error(`Read out of range (Int8) at pos ${this.position} (buffer: ${this.buffer.length})`);
        }
        return this.buffer.readInt8(this.position++);
    }

    readInt16() {
        if (this.position + 2 > this.buffer.length) {
            throw new Error(`Read out of range (Int16) at pos ${this.position}`);
        }
        const val = this.endianness === 'little' ? this.buffer.readInt16LE(this.position) : this.buffer.readInt16BE(this.position);
        this.position += 2;
        return val;
    }

    readUint16() {
        if (this.position + 2 > this.buffer.length) {
            throw new Error(`Read out of range (Uint16) at pos ${this.position}`);
        }
        const val = this.endianness === 'little' ? this.buffer.readUInt16LE(this.position) : this.buffer.readUInt16BE(this.position);
        this.position += 2;
        return val;
    }

    readInt32() {
        if (this.position + 4 > this.buffer.length) {
            throw new Error(`Read out of range (Int32) at pos ${this.position}`);
        }
        const val = this.endianness === 'little' ? this.buffer.readInt32LE(this.position) : this.buffer.readInt32BE(this.position);
        this.position += 4;
        return val;
    }

    readUint32() {
        if (this.position + 4 > this.buffer.length) {
            throw new Error(`Read out of range (Uint32) at pos ${this.position}`);
        }
        const val = this.endianness === 'little' ? this.buffer.readUInt32LE(this.position) : this.buffer.readUInt32BE(this.position);
        this.position += 4;
        return val;
    }

    /**
     * Reads a 4-character code, handling endianness reversal for little-endian files (XFIR).
     */
    readFourCC() {
        if (this.position + 4 > this.buffer.length) {
            throw new Error(`Read out of range (FourCC) at pos ${this.position}`);
        }
        let res = this.buffer.toString('ascii', this.position, this.position + 4);
        if (this.endianness === 'little') res = res.split('').reverse().join('');
        this.position += 4;
        return res;
    }

    peekFourCC() {
        if (this.position + 4 > this.buffer.length) return "";
        let res = this.buffer.toString('ascii', this.position, this.position + 4);
        if (this.endianness === 'little') res = res.split('').reverse().join('');
        return res;
    }

    /**
     * Reads a Director Variable-Length Integer.
     */
    readVarInt() {
        let val = 0;
        let b;
        let safety = 0;
        do {
            if (this.position >= this.buffer.length) break;
            b = this.readUint8();
            val = (val << 7) | (b & 0x7f);
            if (++safety > 5) break; // VarInts shouldn't be larger than 32-bit (5 bytes max)
        } while (b >> 7);
        return val;
    }

    /**
     * Reads a standard Director Rectangle (top, left, bottom, right).
     */
    readRect() {
        return {
            top: this.readInt16(),
            left: this.readInt16(),
            bottom: this.readInt16(),
            right: this.readInt16()
        };
    }

    /**
     * Reads a 2D Point (x, y).
     */
    readPoint() {
        return {
            x: this.readInt16(),
            y: this.readInt16()
        };
    }

    readString(length) {
        if (this.position + length > this.buffer.length) {
            length = this.buffer.length - this.position;
        }
        const res = this.buffer.toString('utf8', this.position, this.position + length);
        this.position += length;
        return res;
    }

    readFloat() {
        if (this.position + 4 > this.buffer.length) {
            throw new Error(`Read out of range (Float) at pos ${this.position}`);
        }
        const val = this.endianness === 'little' ? this.buffer.readFloatLE(this.position) : this.buffer.readFloatBE(this.position);
        this.position += 4;
        return val;
    }

    readDouble() {
        if (this.position + 8 > this.buffer.length) {
            throw new Error(`Read out of range (Double) at pos ${this.position}`);
        }
        const val = this.endianness === 'little' ? this.buffer.readDoubleLE(this.position) : this.buffer.readDoubleBE(this.position);
        this.position += 8;
        return val;
    }

    readUint24() {
        if (this.position + 3 > this.buffer.length) {
            throw new Error(`Read out of range (Uint24) at pos ${this.position}`);
        }
        let result;
        if (this.endianness === 'little') {
            result = this.buffer.readUInt8(this.position) |
                (this.buffer.readUInt8(this.position + 1) << 8) |
                (this.buffer.readUInt8(this.position + 2) << 16);
        } else {
            result = (this.buffer.readUInt8(this.position) << 16) |
                (this.buffer.readUInt8(this.position + 1) << 8) |
                this.buffer.readUInt8(this.position + 2);
        }
        this.position += 3;
        return result;
    }
}

module.exports = DataStream;
