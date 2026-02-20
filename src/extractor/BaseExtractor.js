const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const DataStream = require('../utils/DataStream');
const { Resources } = require('../Constants');

class BaseExtractor {
    constructor(logger) {
        this.logger = logger;
        this.extractionLog = [];
    }

    getStream(buffer, endianness = 'big') {
        return new DataStream(buffer, endianness);
    }

    saveFile(buffer, outputPath, type = Resources.Labels.Generic) {
        try {
            const dir = path.dirname(outputPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            this.log('DEBUG', `[BaseExtractor] Writing ${buffer.length} bytes to ${outputPath} (Type: ${type})`);
            fs.writeFileSync(outputPath, buffer);
            const checksum = crypto.createHash('sha256').update(buffer).digest('hex');
            return { success: true, file: path.basename(outputPath), path: outputPath, format: type, checksum };
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
        const outPath = path.join(this.outputDir, `members.${Resources.Formats.JSON}`);
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
