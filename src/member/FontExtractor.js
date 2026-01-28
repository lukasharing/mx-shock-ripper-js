/**
 * @version 1.2.0
 * FontExtractor.js - Extraction logic for Director VWFT/FONT assets
 * 
 * Preserves the proprietary binary structure of Director font members, 
 * but attempts to extract standard TTF/OTF fonts if embedded.
 */

const GenericExtractor = require('./GenericExtractor');
const DataStream = require('../utils/DataStream');

class FontExtractor extends GenericExtractor {
    constructor(log) {
        super(log);
    }

    /**
     * Inspects the buffer for standard Font signatures.
     */
    extract(buffer) {
        if (!buffer || buffer.length < 12) return { data: buffer, ext: '.font' };

        const ds = new DataStream(buffer, 'big');

        // Scan for standard Font signatures (TTF usually starts with 0x00010000 or 'OTTO')
        // Director fonts often have a header before the actual font data.
        // We'll scan the first 512 bytes for a signature.

        const limit = Math.min(buffer.length - 4, 512);

        // TTF Signature: 0x00010000
        // OTF Signature: 'OTTO' (0x4F54544F)

        for (let i = 0; i < limit; i++) {
            const sig = buffer.readUInt32BE(i);
            if (sig === 0x00010000 || sig === 0x4F54544F) { // OTTO
                // Found potential font start
                return {
                    data: buffer.slice(i),
                    ext: (sig === 0x4F54544F) ? '.otf' : '.ttf'
                };
            }
        }

        return { data: buffer, ext: '.font' };
    }

    /**
     * Persists the font data.
     */
    save(buffer, outputPath) {
        if (!buffer) return null;

        const result = this.extract(buffer);
        const finalPath = outputPath.endsWith(result.ext) ? outputPath : outputPath + result.ext;

        return this.saveFile(result.data, finalPath, `Font (${result.ext})`);
    }
}

module.exports = FontExtractor;
