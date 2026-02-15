const path = require('path');
const fs = require('fs');

class BaseExtractor {
    constructor(logger) {
        this.logger = logger;
        this.extractionLog = [];
    }

    getStream(buffer, endianness = 'big') {
        const DataStream = require('../utils/DataStream');
        return new DataStream(buffer, endianness);
    }

    saveFile(buffer, outputPath, type = "generic") {
        try {
            const dir = path.dirname(outputPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            this.log('DEBUG', `[BaseExtractor] Writing ${buffer.length} bytes to ${outputPath} (Type: ${type})`);
            fs.writeFileSync(outputPath, buffer);
            return { success: true, file: path.basename(outputPath), path: outputPath, format: type };
        } catch (e) {
            this.log('ERROR', `Failed to save ${type} to ${outputPath}: ${e.message}`);
            return null;
        }
    }

    log(lvl, msg) {
        if (this.logger && this.logger !== this && typeof this.logger === 'function') {
            this.logger(lvl, msg);
        } else if (this.logger && this.logger !== this && typeof this.logger.log === 'function') {
            this.logger.log(lvl, msg);
        }
        this.extractionLog.push({ timestamp: new Date().toISOString(), lvl, msg });
    }

    saveJSON() {
        if (!this.outputDir || !this.metadata) return;
        const outPath = path.join(this.outputDir, "members.json");
        fs.writeFileSync(outPath, JSON.stringify(this.metadata, null, 2));
        fs.writeFileSync(outPath, JSON.stringify(this.metadata, null, 2));
    }

    saveLog() {
        if (!this.outputDir || !this.inputPath) return;
        const name = path.basename(this.inputPath, path.extname(this.inputPath));
        const outPath = path.join(this.outputDir, `${name}_extraction.log`);
        const logContent = this.extractionLog.map(l => `[${l.timestamp}] [${l.lvl}] ${l.msg}`).join('\n');
        fs.writeFileSync(outPath, logContent);
    }
}

module.exports = BaseExtractor;
