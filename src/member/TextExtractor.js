/**
 * @version 1.4.2
 * TextExtractor.js - Extraction logic for Director Text and Field members
 * 
 * Handles STXT and TEXT chunks. Exports as RTF to preserve potential formatting 
 * structure (even if style parsing is basic for now).
 */

const path = require('path');
const GenericExtractor = require('./GenericExtractor');
const DataStream = require('../utils/DataStream');
const { HeaderSize, Resources } = require('../Constants');
const { sanitizeArtifactStem } = require('../utils/ArtifactNames');

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
        const chunkId = options.chunkId || 'N/A';
        this.log(
            'DEBUG',
            `[TextExtractor] Extracting chunk ${chunkId}: ${buffer.length} bytes. First 8 bytes: ${buffer.slice(0, 8).toString('hex')} (useRaw: ${!!options.useRaw})`
        );

        // Detect modern 12-byte STXT header: [4:HdrSize][4:TxtSize][4:StyleSize]
        // HeaderSize.Stxt should be 12. Check if the first 4 bytes match the header size.
        if (buffer.length >= HeaderSize.Stxt) {
            const ds = new DataStream(buffer, 'big');
            const headerSize = ds.readUint32();
            const textSize = ds.readUint32();

            // Additional check: Does it look like an STXT chunk?
            // Usually headerSize is 12 and textSize matches the rest of the buffer (excluding styles)
            if (headerSize === HeaderSize.Stxt && headerSize + textSize <= buffer.length) {
                content = buffer.slice(headerSize, headerSize + textSize).toString('utf8');
            } else {
                // If it doesn't look like STXT, treat it as raw text
                content = buffer.toString('utf8');
            }
        } else {
            content = buffer.toString('utf8');
        }

        const cleanContent = this.normalizeContent(content);
        if (options.useRaw) return cleanContent;

        return this.formatRTF(cleanContent);
    }

    normalizeContent(content) {
        return String(content || '')
            .replace(/\0/g, '')
            .replace(/\r\n/g, '\n')
            .replace(/\r/g, '\n')
            .trim();
    }

    inferSemanticName(cleanText, member) {
        const currentName = member?.name || '';
        if (!/^member_\d+$/.test(currentName)) return null;

        const lines = String(cleanText || '')
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0);

        if (lines.length < 4) return null;
        if (lines[0] !== '#object' || lines[1] !== '#class' || lines[2] !== '#list') return null;

        const assignmentRows = lines
            .slice(3)
            .filter(line => /^[^#=\s][^=]*=\s*\[/.test(line))
            .length;

        if (assignmentRows >= 20) {
            return 'fuse.object.classes';
        }

        return null;
    }

    /**
     * Formats raw text into a simple RTF document.
     */
    formatRTF(cleanText) {
        const normalized = this.normalizeContent(cleanText);
        // Escape RTF special characters
        const escaped = normalized
            .replace(/\\/g, '\\\\')
            .replace(/{/g, '\\{')
            .replace(/}/g, '\\}')
            .replace(/\n/g, '\\par\n');

        return `{\\rtf1\\ansi\\deff0\n{\\fonttbl{\\f0\\fswiss\\fcharset0 Arial;}}\n\\viewkind4\\uc1\\pard\\lang1033\\f0\\fs20 ${escaped}\\par\n}`;
    }

    /**
     * Saves the extracted text.
     */
    save(buffer, outputPath, member, options = {}) {
        const rawContent = this.normalizeContent(this.extract(buffer, { ...options, useRaw: true }));
        const semanticName = this.inferSemanticName(rawContent, member);
        const content = options.useRaw ? rawContent : this.formatRTF(rawContent);

        const parsedPath = path.parse(outputPath);
        const baseStem = semanticName
            ? sanitizeArtifactStem(semanticName, parsedPath.name || `member_${member?.id || 'text'}`)
            : parsedPath.name;
        const finalExt = options.useRaw
            ? (parsedPath.ext || '.txt')
            : `.${Resources.Formats.RTF}`;
        const finalPath = path.join(parsedPath.dir, `${baseStem}${finalExt}`);

        const formatLabel = options.useRaw ? "Text (Raw)" : "Text (RTF)";
        const result = this.saveFile(Buffer.from(content, 'utf8'), finalPath, formatLabel);

        if (result) {
            if (semanticName && member) {
                this.log('INFO', `Semantic text rename ${member.name} -> ${semanticName}`);
            }
            return {
                file: result.file,
                size: result.size,
                format: options.useRaw ? ((parsedPath.ext || '').replace(/^\./, '') || Resources.Formats.TEXT || 'txt') : Resources.Formats.RTF,
                renamed: semanticName || undefined
            };
        }
        return false;
    }
}

module.exports = TextExtractor;
