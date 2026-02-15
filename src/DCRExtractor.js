/**
 * @version 1.3.6
 * DCRExtractor.js - Full project orchestrator for Adobe Director (.dcr)
 * 
 * Handles multi-file extraction by loading the entry movie and recursively 
 * discovering all linked cast libraries. Manages the global shared palette 
 * context to ensure consistent bitmap coloring across the project.
 */

const fs = require('fs');
const path = require('path');
const DirectorExtractor = require('./DirectorExtractor');
const ProjectExtractor = require('./ProjectExtractor');
const Logger = require('./utils/Logger');

class DCRExtractor {
    /**
     * @param {string} inputPath - Path to the primary project file (.dcr)
     * @param {string} outputDir - Path to the extraction target directory
     * @param {object} options - Generation options
     */
    constructor(inputPath, outputDir, options = {}) {
        this.inputPath = inputPath;
        this.outputDir = outputDir;
        this.options = options;
        this.baseName = path.parse(inputPath).name;
        this.log = (lvl, msg) => console.log(`[DCRExtractor][${lvl}] ${msg}`);
    }

    /**
     * Executes the full project extraction workflow.
     */
    async extract() {


        // 1. Context Discovery: Load linkages and shared palettes
        const project = new ProjectExtractor(this.inputPath, this.options, this.log);
        await project.init();

        // 2. Recursive Extraction: Process all discovered cast libraries
        const outputRoot = path.dirname(this.outputDir);

        for (const cast of project.loadedCasts) {
            const isMain = (path.resolve(cast.path) === path.resolve(this.inputPath));
            const targetDir = isMain ? this.outputDir : path.join(outputRoot, path.parse(cast.path).name);

            if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });



            const extractor = new DirectorExtractor(cast.path, targetDir, {
                ...this.options,
                projectContext: project // Pass global palette context
            });

            try {
                await extractor.extract();
            } catch (e) {
                console.error(`[DCRExtractor][ERROR] Segment failure: ${path.basename(cast.path)} - ${e.message}`);
            }
        }

        // 3. Finalize Project Resources
        project.savePalettes(outputRoot);
    }
}

module.exports = DCRExtractor;
