/** @version 1.1.7 - Generic Director Asset Ripper */
const DataStream = require('../utils/DataStream');
const GenericExtractor = require('./GenericExtractor');
const { Resources: { Labels } } = require('../Constants');

/**
 * @version 1.1.7
 * PaletteExtractor - Handles parsing and formatting of Director palette (CLUT) assets.
 * 
 * See docs/doc/09_PaletteExtraction.md for technical details.
 */
class PaletteExtractor extends GenericExtractor {
    constructor(logger) {
        super(logger);
    }

    /**
     * Parse palette binary data into an array of [R, G, B] using multi-strategy detection.
     */
    parse(paletteBuf, endianness) {
        if (!paletteBuf || paletteBuf.length === 0) return [];

        let palette = this._parse16BitColors(paletteBuf, endianness);
        if (palette.length > 0) return palette;

        palette = this._parse8BitColors(paletteBuf);
        if (palette.length > 0) return palette;

        palette = this._parseExtendedColors(paletteBuf);
        return palette;
    }

    /**
     * Strategy 1: Legacy 6-byte format (16-bit channels)
     */
    _parse16BitColors(buffer, endianness) {
        if (buffer.length < 768 * 2) return [];
        const palette = [];
        const pds = new DataStream(buffer, endianness);
        const palTotal = Math.floor(buffer.length / 6);
        for (let i = 0; i < palTotal; i++) {
            if (palette.length >= 256) break;
            palette.push([pds.readUint16() >> 8, pds.readUint16() >> 8, pds.readUint16() >> 8]);
        }
        return palette;
    }

    /**
     * Strategy 2: 3-byte RGB format
     */
    _parse8BitColors(buffer) {
        if (buffer.length < 768) return [];
        const palette = [];
        let offset = 0;
        if (buffer.length > 768 && (buffer.length - 768) < 20) offset = buffer.length - 768;
        for (let i = offset; i < buffer.length; i += 3) {
            if (palette.length >= 256 || i + 3 > buffer.length) break;
            palette.push([buffer[i], buffer[i + 1], buffer[i + 2]]);
        }
        return palette;
    }

    /**
     * Strategy 3: 4-byte RGBA/RGBX format fallback
     */
    _parseExtendedColors(buffer) {
        if (buffer.length < 1024) return [];
        const palette = [];
        const offset = buffer.length === 1024 ? 0 : (buffer.length - 1024);
        for (let i = offset; i < buffer.length; i += 4) {
            if (palette.length >= 256 || i + 4 > buffer.length) break;
            palette.push([buffer[i], buffer[i + 1], buffer[i + 2]]);
        }
        return palette;
    }

    /**
     * Format palette as JASC-PAL string
     */
    formatJasc(palette) {
        let content = "JASC-PAL\r\n0100\r\n256\r\n";
        for (let i = 0; i < 256; i++) {
            const color = palette[i] || [0, 0, 0];
            content += `${color[0]} ${color[1]} ${color[2]}\r\n`;
        }
        return content;
    }

    /**
     * Persists the palette to disk in JASC-PAL format.
     */
    save(palette, outputPath, member) {
        const content = this.formatJasc(palette);
        const res = this.saveFile(content, outputPath, "Palette");
        if (res && member) member.paletteFile = res.file;
        return res;
    }
}

module.exports = PaletteExtractor;
