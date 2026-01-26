/**
 * @version 1.0.0
 * CCTExtractor.js - Standalone Cast Library extraction utility
 * 
 * Simple orchestrator for processing .cct or .cst files. Leverages 
 * DirectorExtractor for core payload analysis and asset recovery.
 */

const fs = require('fs');
const DirectorExtractor = require('./DirectorExtractor');

class CCTExtractor {
    /**
     * @param {string} inputPath - Path to the source cast file
     * @param {string} outputDir - Path to the extraction target directory
     * @param {object} options - Generation options
     */
    constructor(inputPath, outputDir, options = {}) {
        this.inputPath = inputPath;
        this.outputDir = outputDir;
        this.options = options;
    }

    /**
     * Executes the extraction workflow for a single cast library.
     */
    async extract() {
        if (!fs.existsSync(this.outputDir)) fs.mkdirSync(this.outputDir, { recursive: true });

        const extractor = new DirectorExtractor(this.inputPath, this.outputDir, this.options);
        try {
            return await extractor.extract();
        } catch (e) {
            console.error(`[CCTExtractor][ERROR] Extraction failed: ${e.message}`);
            throw e;
        }
    }
}

module.exports = CCTExtractor;
