/**
 * @version 1.3.5
 * TextExtractor.js - Extraction logic for Director Text and Field members
 * 
 * Handles STXT and TEXT chunks. Exports as RTF to preserve potential formatting 
 * structure (even if style parsing is basic for now).
 */

const GenericExtractor = require('./GenericExtractor');
const DataStream = require('../utils/DataStream');
const { HeaderSize } = require('../Constants');

class TextExtractor extends GenericExtractor {
    constructor(log) {
        super(log);
    }

    /**
     * Extracts text, optionally wrapping it in an RTF container.
     */
    extract(buffer, options = {}) {
        if (!buffer || buffer.length === 0) return "";

        let content = "";

        // Detect modern 12-byte STXT header: [4:HdrSize][4:TxtSize][4:StyleSize]
        if (buffer.length >= HeaderSize.Stxt) {
            const ds = new DataStream(buffer, 'big');
            const headerSize = ds.readUint32();
            const textSize = ds.readUint32();

            if (headerSize >= HeaderSize.Stxt && headerSize + textSize <= buffer.length) {
                content = buffer.slice(headerSize, headerSize + textSize).toString('utf8');
            } else {
                content = buffer.toString('utf8');
            }
        } else {
            content = buffer.toString('utf8');
        }

        const cleanContent = content.replace(/\0/g, '').trim();
        if (options.useRaw) return cleanContent;

        return this.formatRTF(cleanContent);
    }

    /**
     * Formats raw text into a simple RTF document.
     */
    formatRTF(cleanText) {
        // Escape RTF special characters
        const escaped = cleanText
            .replace(/\\/g, '\\\\')
            .replace(/{/g, '\\{')
            .replace(/}/g, '\\}')
            .replace(/\r/g, '\\par\n')
            .replace(/\n/g, '\\par\n'); // Handle both line endings

        return `{\\rtf1\\ansi\\deff0\n{\\fonttbl{\\f0\\fswiss\\fcharset0 Arial;}}\n\\viewkind4\\uc1\\pard\\lang1033\\f0\\fs20 ${escaped}\\par\n}`;
    }

    /**
     * Saves the extracted text.
     */
    save(buffer, outputPath, member, options = {}) {
        const rtfContent = this.extract(buffer, options);
        // Use the provided outputPath extension if it's already there (e.g. .props)
        const finalPath = (outputPath.includes('.') && !outputPath.endsWith('.rtf')) ? outputPath :
            (outputPath.endsWith('.rtf') ? outputPath : outputPath + '.rtf');

        const formatLabel = options.useRaw ? "Text (Raw)" : "Text (RTF)";
        const result = this.saveFile(Buffer.from(rtfContent, 'utf8'), finalPath, formatLabel);

        if (result) {
            return {
                file: result.file,
                size: result.size,
                format: options.useRaw ? (outputPath.split('.').pop() || 'txt') : 'rtf'
            };
        }
        return false;
    }
}

module.exports = TextExtractor;
