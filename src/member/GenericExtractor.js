/**
 * @version 1.2.5
 * GenericExtractor.js - Root class for Director member extraction
 * 
 * Provides standardized file persistence and logging capabilities utilized 
 * by all specialized member extractors.
 */

const fs = require('fs');
const path = require('path');

class GenericExtractor {
    /**
     * @param {Function} log - Logger callback (lvl, msg)
     */
    constructor(log) {
        this.log = log || ((lvl, msg) => console.log(`[${lvl}] ${msg}`));
    }

    /**
     * Persists binary data to the filesystem and logs the operation.
     * @returns {object|null} Metadata about the saved file.
     */
    saveFile(data, outputPath, label = "Asset") {
        try {
            if (!data) return null;
            fs.writeFileSync(outputPath, data);
            this.log('INFO', `Extracted ${label}: ${path.basename(outputPath)}`);
            return { file: path.basename(outputPath), size: data.length };
        } catch (e) {
            this.log('ERROR', `Failed to save ${label}: ${e.message}`);
            return null;
        }
    }

    /**
     * Fallback save method for raw chunk persistence.
     */
    save(buffer, outputPath) {
        return this.saveFile(buffer, outputPath, "RawData");
    }
}

module.exports = GenericExtractor;
