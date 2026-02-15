/**
 * @version 1.3.6
 * Color.js - Color utilities and index resolution
 */

const { PALETTES } = require('./Palette');

class Color {
    /**
     * Resolves a palette index to a hex color string.
     * @param {number} index 
     * @param {Array} palette 
     */
    static resolve(index, palette = null) {
        const pal = palette || PALETTES.MAC;
        const rgb = (index >= 0 && index < pal.length) ? pal[index] : [0, 0, 0];
        return this.toHex(rgb);
    }

    /**
     * Converts RGB array to standardized Hex string.
     */
    static toHex(rgb) {
        if (!rgb || rgb.length < 3) return '#000000';
        return '#' + rgb.map(c => c.toString(16).padStart(2, '0')).join('');
    }
}

module.exports = {
    Color,
    PALETTES
};
