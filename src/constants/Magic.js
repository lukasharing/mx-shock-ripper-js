/**
 * @version 1.2.1
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
    ALFA: 'ALFA', // Alpha Mask
    SHAP: 'SHAP', // Shape Data
    XTRA: 'XTRA', // Xtra Data
    CAST_SPACE: 'CAS ',
    KEY_SPACE: 'KEY ',
    MV93: 'MV93', // Movie (Dir 4+)
    MVPV: 'MVPV', // Movie (Afterburner)
    MC93: 'MC93', // Cast (Dir 4+)
    MCsL: 'MCsL', // Movie Cast Script List
    Lscl: 'Lscl', // Protected Cast List
    VWCF: 'VWCF', // Vector Config
    conf: 'conf', // Config
    VWky: 'VWky', // Memory Map Key
    DRCF: 'DRCF', // Config (Dir 5+)
    SCORE: 'Score', // Score/Timeline
    VWSC: 'VWSC'  // Score (Dir 4+)
};
