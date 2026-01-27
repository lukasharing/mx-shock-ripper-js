/**
 * @version 1.1.7
 * TextExtractor.js - Extraction logic for Director Text and Field members
 * 
 * Handles modern Shockwave STXT headers (12-byte) and classic TEXT chunks. 
 * Normalizes line endings and character encoding for production use.
 */

const GenericExtractor = require('./GenericExtractor');
const DataStream = require('../utils/DataStream');
const { HeaderSize } = require('../Constants');

class TextExtractor extends GenericExtractor {
    constructor(log) {
        super(log);
    }

    /**
     * Extracts and normalizes text from STXT or TEXT buffers.
     */
    extract(buffer) {
        if (!buffer || buffer.length === 0) return "";

        let content = "";
        // Detect modern 12-byte STXT header: [4:HdrSize][4:TxtSize][4:StyleSize]
        if (buffer.length >= HeaderSize.Stxt) {
            const ds = new DataStream(buffer, 'big');
            const headerSize = ds.readUint32();
            const textSize = ds.readUint32();

            if (headerSize >= HeaderSize.Stxt && headerSize + textSize <= buffer.length) {
                content = buffer.slice(headerSize, headerSize + textSize).toString('utf8');
            } else {
                content = buffer.toString('utf8');
            }
        } else {
            content = buffer.toString('utf8');
        }

        // Production Sanitization: Normalize line endings and strip null padding
        return content.replace(/\r/g, '\n').replace(/\0/g, '').trim();
    }
}

module.exports = TextExtractor;
