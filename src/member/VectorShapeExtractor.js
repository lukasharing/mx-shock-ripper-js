/**
 * @version 1.3.0
 * VectorShapeExtractor.js - Extraction logic for Vector Shape members (Type 18)
 */

const GenericExtractor = require('./GenericExtractor');

class VectorShapeExtractor extends GenericExtractor {
    constructor(log) {
        super(log);
    }

    /**
     * Saves the raw Vector Shape data to a file.
     * Since the format is undocumented (proprietary binary), we dump the raw generic data.
     */
    save(data, outputPath, member) {
        // We do not have a parser for Vector Shape (Type 18).
        // Dump the raw content for future analysis.
        const finalPath = outputPath + '.dat';
        const result = this.saveFile(data, finalPath, "VectorShape (Raw)");

        if (result) {
            return {
                file: result.file,
                size: result.size,
                format: 'dat'
            };
        }
        return false;
    }
}

module.exports = VectorShapeExtractor;
