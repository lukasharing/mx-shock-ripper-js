/**
 * @version 1.3.0
 * LnamParser.js
 * 
 * Parses Lingo Name Table (Lnam) chunks into symbol arrays.
 */

const DataStream = require('../utils/DataStream');

class LnamParser {
    constructor(logger) {
        this.log = logger || console.log;
    }

    /**
     * Parses a Lingo Name Table (Lnam) chunk.
     * @param {Buffer} buffer - Raw Lnam chunk data.
     * @returns {string[]} Array of symbol names.
     */
    parse(buffer) {
        try {
            // Lingo metadata is always big-endian.
            const stream = new DataStream(buffer, 'big');

            // Header fields (some are unknown/reserved)
            const unknown0 = stream.readInt32();
            const unknown1 = stream.readInt32();
            const chunkLen1 = stream.readUint32();
            const chunkLen2 = stream.readUint32();
            const namesOffset = stream.readUint16();
            const nameCount = stream.readUint16();

            // Jump to the start of the string array
            stream.seek(namesOffset);
            const names = [];

            for (let i = 0; i < nameCount; i++) {
                // Each name is a Pascal string (Length Byte + Characters)
                const nameLen = stream.readUint8();

                if (nameLen > 0 && stream.position + nameLen <= buffer.length) {
                    const name = stream.readString(nameLen);
                    names.push(name);
                } else {
                    // Empty entries are common in padded or corrupt tables
                    names.push('');
                }
            }

            return names;
        } catch (e) {
            this.log('ERROR', `Lnam parsing failed: ${e.message}`);
            return [];
        }
    }
}

module.exports = LnamParser;
