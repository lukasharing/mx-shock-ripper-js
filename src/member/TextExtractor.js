/**
 * @version 1.2.8
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
     * Extracts text and wraps it in a basic RTF container.
     */
    extract(buffer) {
        if (!buffer || buffer.length === 0) return "";

        let content = "";
        let stylesBuffer = null;

        // Detect modern 12-byte STXT header: [4:HdrSize][4:TxtSize][4:StyleSize]
        if (buffer.length >= HeaderSize.Stxt) {
            const ds = new DataStream(buffer, 'big');
            const headerSize = ds.readUint32();
            const textSize = ds.readUint32();
            // const styleSize = ds.readUint32();

            if (headerSize >= HeaderSize.Stxt && headerSize + textSize <= buffer.length) {
                content = buffer.slice(headerSize, headerSize + textSize).toString('utf8');
                // stylesBuffer = buffer.slice(headerSize + textSize, headerSize + textSize + styleSize);
            } else {
                content = buffer.toString('utf8');
            }
        } else {
            content = buffer.toString('utf8');
        }

        return this.formatRTF(content);
    }

    /**
     * Formats raw text into a simple RTF document.
     */
    formatRTF(rawText) {
        const cleanText = rawText.replace(/\0/g, '').trim(); // Remove nulls
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
     * Saves the extracted text as an RTF file.
     */
    save(buffer, outputPath, member) {
        const rtfContent = this.extract(buffer);
        const finalPath = outputPath.endsWith('.rtf') ? outputPath : outputPath + '.rtf';
        const result = this.saveFile(Buffer.from(rtfContent, 'utf8'), finalPath, "Text (RTF)");
        if (result) {
            return {
                file: result.file,
                size: result.size,
                format: 'rtf'
            };
        }
        return false;
    }
}

module.exports = TextExtractor;
