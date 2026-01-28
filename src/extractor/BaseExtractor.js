const fs = require('fs');
const path = require('path');

class BaseExtractor {
    constructor(inputPath, outputDir, options = {}) {
        this.inputPath = inputPath;
        this.baseName = path.parse(inputPath).name;
        this.outputDir = outputDir || path.join(process.cwd(), 'extractions', this.baseName);
        this.options = options;

        this.extractionLog = [];
        this.stats = { total: 0, byType: {}, protectedScripts: 0, paletteRefs: { global: 0, relative: 0 } };

        this.metadata = {
            fileName: path.basename(inputPath),
            project: this.baseName,
            timestamp: new Date().toISOString(),
            members: []
        };
    }

    log(lvl, msg) {
        this.extractionLog.push({ timestamp: new Date().toISOString(), lvl, msg });
        const color = lvl === 'ERROR' ? '\x1b[31m' : (lvl === 'SUCCESS' ? '\x1b[32m' : '\x1b[0m');
        console.log(`${color}[DirectorExtractor][${lvl}] ${msg}\x1b[0m`);
    }

    saveJSON() {
        fs.writeFileSync(path.join(this.outputDir, 'members.json'), JSON.stringify(this.metadata, null, 2));
    }

    saveLog() {
        const logContent = this.extractionLog.map(e => `[${e.timestamp}] ${e.lvl.padEnd(5)} ${e.msg}`).join('\n');
        fs.writeFileSync(path.join(this.outputDir, `${this.baseName}_extraction.log`), logContent);
    }
}

module.exports = BaseExtractor;
