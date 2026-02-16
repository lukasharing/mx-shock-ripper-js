/**
 * @version 1.4.0
 * Bitmap.js - Attribute flags and masks for Director Bitmap members
 */

module.exports = {
    Flags: {
        HasCustomPalette: 0x8000,
        AlphaChannelUsed: 0x4000,
        Dither: 0x0040,
        TrimWhiteSpace: 0x0002
    },
    BitMask: {
        RowBytes: 0x7FFF
    },
    BitDepth: [1, 2, 4, 8, 16, 24, 32],
    Alpha: {
        Opaque: 255,
        Transparent: 0
    },
    ChannelOrder: {
        DEFAULT: 'DEFAULT',
        ARGB: 'ARGB',
        RGBA: 'RGBA',
        BGRA: 'BGRA',
        ROW_PLANAR_ARGB: 'ROW_PLANAR_ARGB',
        ROW_PLANAR: 'ROW_PLANAR_',
        PLANAR: 'PLANAR_'
    },
    BitmapTags: ['BITD', 'bitd', 'DIB ', 'DIB*', 'Abmp', 'PMBA']
};
