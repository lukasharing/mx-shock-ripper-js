/**
 * @version 1.0.0
 * Magic.js - FourCC identifiers and Magic numbers for Director chunks
 */

module.exports = {
    RIFX: 'RIFX', // Big Endian Movie
    XFIR: 'XFIR', // Little Endian Movie
    FGDC: 'FGDC', // Compressed Afterburner/Shockwave
    IMAP: 'imap', // Initial Map
    MMAP: 'mmap', // Memory Map
    KEY: 'KEY*',  // Key Table
    CAST: 'CASt', // Cast Member Data
    LNAM: 'Lnam', // Lingo Name Table
    LSCR: 'Lscr', // Lingo Script Bytecode
    LCTX: 'LctX', // Lingo Context (Metadata)
    VWFT: 'VWFT', // Vector Font
    FONT: 'FONT', // Standard Font
    CLUT: 'CLUT', // Palette (Color Lookup Table)
    BITD: 'BITD', // Bitmap Data
    SND: 'SND ',  // Sound (Stereo/Mono PCM)
    snd: 'snd ',  // Sound (Platform-specific lowercase)
    STXT: 'STXT', // Script Text (Lingo source)
    TEXT: 'TEXT', // Text Member Content
    ALFA: 'ALFA'  // Alpha Mask
};
