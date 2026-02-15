/**
 * @version 1.3.6
 * ScriptExtractor.js - Post-processing and persistence for Lingo scripts
 * 
 * Implements a rule-based beautification engine for raw decompiled Lingo code 
 * to ensure high readability and standard indentation.
 */

const GenericExtractor = require('./GenericExtractor');

class ScriptExtractor extends GenericExtractor {
    constructor(log) {
        super(log);
    }

    /**
     * Applies standard Lingo indentation and formatting to decompiled source.
     */
    beautify(text) {
        if (!text) return "";
        let indent = 0;
        const lines = text.split(/\r?\n/);

        return lines.map(line => {
            const raw = line.trim();
            if (!raw) return "";

            const lower = raw.toLowerCase();
            // Decrease indent BEFORE the line if it's a closer
            if (lower.startsWith('end') || lower.startsWith('next') || lower.startsWith('loop')) {
                indent = Math.max(0, indent - 1);
            }

            const formatted = "  ".repeat(indent) + raw;

            // Increase indent AFTER the line if it's an opener
            if (lower.startsWith('on ') || lower.startsWith('if ') || lower.startsWith('repeat ') || lower.startsWith('case ')) {
                indent++;
            }

            return formatted;
        }).join('\n');
    }

    /**
     * Save formatted Lingo script to the filesystem.
     */
    save(content, outputPath) {
        if (!content) return null;
        const formatted = this.beautify(content);
        return this.saveFile(Buffer.from(formatted, 'utf8'), outputPath, "Script");
    }
}

module.exports = ScriptExtractor;
