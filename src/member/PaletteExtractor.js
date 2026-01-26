/** @version 1.1.5 - Generic Director Asset Ripper */
const DataStream = require('../utils/DataStream');
const GenericExtractor = require('./GenericExtractor');
const { Resources: { Labels } } = require('../Constants');

/**
 * PaletteExtractor - Handles parsing and formatting of Director palette (CLUT) assets.
 * 
 * STRUCTURE:
 * - CLUT Chunks: Contain a series of 6-byte RGB entries.
 * - RGB Format: Each color is stored as three 16-bit integers (R, G, B), 
 *   though typically only the upper 8 bits are used for standard 24-bit color depth.
 * 
 * FORMATTING:
 * - JASC-PAL: Exported as a standard PaintShop Pro palette format for compatibility with external tools.
 */
class PaletteExtractor extends GenericExtractor {
    constructor(logger) {
        super(logger);
    }

    /**
     * Parse palette binary data into an array of [R, G, B]
     */
    parse(paletteBuf, endianness) {
        if (!paletteBuf || paletteBuf.length === 0) return [];
        const palette = [];

        // Strategy 1: Legacy 6-byte format (16-bit channels)
        if (paletteBuf.length >= 768 * 2) {
            const pds = new DataStream(paletteBuf, endianness);
            const palTotal = Math.floor(paletteBuf.length / 6);
            for (let i = 0; i < palTotal; i++) {
                if (palette.length >= 256) break;
                const r = pds.readUint16() >> 8;
                const g = pds.readUint16() >> 8;
                const b = pds.readUint16() >> 8;
                palette.push([r, g, b]);
            }
            return palette;
        }

        // Strategy 2: 3-byte RGB format
        let offset = 0;
        if (paletteBuf.length === 768) offset = 0;
        else if (paletteBuf.length > 768 && (paletteBuf.length - 768) < 20) offset = paletteBuf.length - 768;

        if (paletteBuf.length >= 768) {
            for (let i = offset; i < paletteBuf.length; i += 3) {
                if (palette.length >= 256 || i + 3 > paletteBuf.length) break;
                palette.push([paletteBuf[i], paletteBuf[i + 1], paletteBuf[i + 2]]);
            }
        }

        // Strategy 3: 4-byte RGBA/RGBX format fallback
        if (palette.length < 255 && paletteBuf.length >= 1024) {
            palette.length = 0;
            offset = paletteBuf.length === 1024 ? 0 : (paletteBuf.length - 1024);
            for (let i = offset; i < paletteBuf.length; i += 4) {
                if (palette.length >= 256 || i + 4 > paletteBuf.length) break;
                palette.push([paletteBuf[i], paletteBuf[i + 1], paletteBuf[i + 2]]);
            }
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
        if (res && member) {
            member.paletteFile = res.file;
        }
        return res;
    }
}

module.exports = PaletteExtractor;
