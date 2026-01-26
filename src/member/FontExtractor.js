/**
 * @version 1.1.5
 * FontExtractor.js - Extraction logic for Director VWFT/FONT assets
 * 
 * Preserves the proprietary binary structure of Director font members to ensure 
 * compatibility with original engines or specialized conversion tools.
 */

const GenericExtractor = require('./GenericExtractor');

class FontExtractor extends GenericExtractor {
    constructor(log) {
        super(log);
    }

    /**
     * Persists the raw font chunk data.
     */
    save(buffer, outputPath) {
        if (!buffer) return null;
        const finalPath = outputPath.endsWith('.font') ? outputPath : outputPath + '.font';
        return this.saveFile(buffer, finalPath, "Font");
    }
}

module.exports = FontExtractor;
