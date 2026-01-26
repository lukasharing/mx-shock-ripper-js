/**
 * @version 1.1.5
 * LnamParser.js - Symbol table parser for Adobe Director Lingo
 * 
 * Extracts the name table (Lnam) which contains identifiers for variables, 
 * handlers, and properties. Supports Pascal-string extraction from big-endian payloads.
 */

const DataStream = require('../utils/DataStream');

class LnamParser {
    constructor(logger) {
        this.log = logger || ((lvl, msg) => console.log(`[LnamParser][${lvl}] ${msg}`));
    }

    /**
     * Parses a Lingo Name Table (Lnam) chunk.
     * @param {Buffer} buffer - Raw Lnam chunk data.
     * @returns {string[]} Array of symbol names.
     */
    parse(buffer) {
        try {
            const ds = new DataStream(buffer, 'big');

            // Header Analysis
            ds.skip(8); // Skip internal chunk linkage (8 bytes)
            const expectedLen = ds.readUint32();
            ds.skip(4); // Duplicate length or flags
            const poolOffset = ds.readUint16();
            const symbolCount = ds.readUint16();

            ds.seek(poolOffset);
            const symbols = [];

            for (let i = 0; i < symbolCount; i++) {
                if (ds.position >= buffer.length) break;
                const len = ds.readUint8();
                if (len > 0 && ds.position + len <= buffer.length) {
                    symbols.push(ds.readString(len));
                } else {
                    symbols.push('');
                }
            }

            return symbols;
        } catch (e) {
            this.log('ERROR', `Lnam extraction failed: ${e.message}`);
            return [];
        }
    }
}

module.exports = LnamParser;
