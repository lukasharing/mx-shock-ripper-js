/** @version 1.1.0 - Generic Director Asset Ripper */
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
        const pds = new DataStream(paletteBuf, endianness);
        const palette = [];
        const palTotal = Math.floor(paletteBuf.length / 6);

        for (let i = 0; i < palTotal; i++) {
            // Palettes in Director use 16-bit values for R, G, B
            // but effectively only the upper 8 bits are used for standard colors
            const r = pds.readUint16() >> 8;
            const g = pds.readUint16() >> 8;
            const b = pds.readUint16() >> 8;
            palette.push([r, g, b]);
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
}

module.exports = PaletteExtractor;
