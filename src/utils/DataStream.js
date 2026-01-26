/**
 * @version 1.1.3
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
            throw new Error(`DataStream: Read out of range at ${this.position} (requested ${length} bytes)`);
        }
        const result = this.buffer.slice(this.position, this.position + length);
        this.position += length;
        return result;
    }

    /**
     * Standard integer readers with endianness resolution.
     */
    readUint8() { return this.buffer.readUInt8(this.position++); }
    readInt8() { return this.buffer.readInt8(this.position++); }

    readInt16() {
        const val = this.endianness === 'little' ? this.buffer.readInt16LE(this.position) : this.buffer.readInt16BE(this.position);
        this.position += 2;
        return val;
    }

    readUint16() {
        const val = this.endianness === 'little' ? this.buffer.readUInt16LE(this.position) : this.buffer.readUInt16BE(this.position);
        this.position += 2;
        return val;
    }

    readInt32() {
        const val = this.endianness === 'little' ? this.buffer.readInt32LE(this.position) : this.buffer.readInt32BE(this.position);
        this.position += 4;
        return val;
    }

    readUint32() {
        const val = this.endianness === 'little' ? this.buffer.readUInt32LE(this.position) : this.buffer.readUInt32BE(this.position);
        this.position += 4;
        return val;
    }

    /**
     * Reads a 4-character code, handling endianness reversal for little-endian files (XFIR).
     */
    readFourCC() {
        let res = this.buffer.toString('ascii', this.position, this.position + 4);
        if (this.endianness === 'little') res = res.split('').reverse().join('');
        this.position += 4;
        return res;
    }

    peekFourCC() {
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
        do {
            b = this.readUint8();
            val = (val << 7) | (b & 0x7f);
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
        const res = this.buffer.toString('utf8', this.position, this.position + length);
        this.position += length;
        return res;
    }

    readDouble() {
        const val = this.endianness === 'little' ? this.buffer.readDoubleLE(this.position) : this.buffer.readDoubleBE(this.position);
        this.position += 8;
        return val;
    }
}

module.exports = DataStream;
