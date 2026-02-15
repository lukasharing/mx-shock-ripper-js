const fs = require('fs');

class DataStream {
    /**
     * @param {Buffer|number} source - Buffer or File Descriptor
     * @param {string} endianness - Initial byte order ('big' or 'little')
     * @param {number} [length] - Total length (required if source is fd)
     */
    constructor(source, endianness = 'big', length = 0) {
        if (typeof source === 'number') {
            this.fd = source;
            this.length = length;
            this.buffer = null;
        } else {
            this.buffer = source;
            this.fd = null;
            this.length = source ? source.length : 0;
        }
        this.position = 0;
        this.endianness = endianness;
        // Small internal buffer for primitive reads when using FD
        this._ioBuf = Buffer.alloc(8);
    }

    seek(pos) {
        this.position = pos;
    }

    skip(n) {
        this.position += n;
    }

    /**
     * Extracts a sub-buffer.
     */
    readBytes(length) {
        if (this.position + length > this.length) {
            throw new Error(`Read out of range: pos=${this.position} len=${length} total=${this.length}`);
        }

        let result;
        if (this.fd !== null) {
            result = Buffer.alloc(length);
            fs.readSync(this.fd, result, 0, length, this.position);
        } else {
            result = this.buffer.slice(this.position, this.position + length);
        }

        this.position += length;
        return result;
    }

    _readIntoBuf(bytes) {
        if (this.position + bytes > this.length) {
            throw new Error(`Read out of range at pos ${this.position}`);
        }
        if (this.fd !== null) {
            fs.readSync(this.fd, this._ioBuf, 0, bytes, this.position);
            this.position += bytes;
            return this._ioBuf;
        } else {
            const buf = this.buffer;
            const pos = this.position;
            this.position += bytes;
            return buf.slice(pos, pos + bytes);
        }
    }

    readUint8() {
        if (this.fd !== null) {
            fs.readSync(this.fd, this._ioBuf, 0, 1, this.position++);
            return this._ioBuf.readUInt8(0);
        }
        return this.buffer.readUInt8(this.position++);
    }

    readInt8() {
        if (this.fd !== null) {
            fs.readSync(this.fd, this._ioBuf, 0, 1, this.position++);
            return this._ioBuf.readInt8(0);
        }
        return this.buffer.readInt8(this.position++);
    }

    readInt16() {
        const buf = this._readIntoBuf(2);
        return this.endianness === 'little' ? buf.readInt16LE(0) : buf.readInt16BE(0);
    }

    readUint16() {
        const buf = this._readIntoBuf(2);
        return this.endianness === 'little' ? buf.readUInt16LE(0) : buf.readUInt16BE(0);
    }

    readInt32() {
        const buf = this._readIntoBuf(4);
        return this.endianness === 'little' ? buf.readInt32LE(0) : buf.readInt32BE(0);
    }

    readUint32() {
        const buf = this._readIntoBuf(4);
        return this.endianness === 'little' ? buf.readUInt32LE(0) : buf.readUInt32BE(0);
    }

    readFourCC() {
        const buf = this._readIntoBuf(4);
        let res = buf.toString('ascii', 0, 4);
        if (this.endianness === 'little') res = res.split('').reverse().join('');
        return res;
    }

    peekFourCC() {
        if (this.position + 4 > this.length) return "";
        let res;
        if (this.fd !== null) {
            fs.readSync(this.fd, this._ioBuf, 0, 4, this.position);
            res = this._ioBuf.toString('ascii', 0, 4);
        } else {
            res = this.buffer.toString('ascii', this.position, this.position + 4);
        }
        if (this.endianness === 'little') res = res.split('').reverse().join('');
        return res;
    }

    readVarInt() {
        let val = 0;
        let b;
        let safety = 0;
        do {
            if (this.position >= this.length) break;
            b = this.readUint8();
            val = (val << 7) | (b & 0x7f);
            if (++safety > 5) break;
        } while (b >> 7);
        return val;
    }

    readRect() {
        return {
            top: this.readInt16(),
            left: this.readInt16(),
            bottom: this.readInt16(),
            right: this.readInt16()
        };
    }

    readPoint() {
        return {
            x: this.readInt16(),
            y: this.readInt16()
        };
    }

    readString(length) {
        if (this.position + length > this.length) {
            length = this.length - this.position;
        }
        const buf = this.readBytes(length);
        return buf.toString('utf8');
    }

    readFloat() {
        const buf = this._readIntoBuf(4);
        return this.endianness === 'little' ? buf.readFloatLE(0) : buf.readFloatBE(0);
    }

    readDouble() {
        const buf = this._readIntoBuf(8);
        return this.endianness === 'little' ? buf.readDoubleLE(0) : buf.readDoubleBE(0);
    }
}

module.exports = DataStream;
