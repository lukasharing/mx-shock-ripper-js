/**
 * @version 1.4.2
 * Magic.js - FourCC identifiers and Magic numbers for Director chunks
 */

module.exports = {
    RIFX: 'RIFX', // Big Endian Movie
    XFIR: 'XFIR', // Little Endian Movie
    FGDC: 'FGDC', // Compressed Afterburner/Shockwave
    IMAP: 'imap', // Initial Map
    MMAP: 'mmap', // Memory Map
    KEY: 'KEY*',  // Key Table
    KEY_STAR: 'KEY*',
    CAST: 'CASt', // Cast Member Data
    LNAM: 'Lnam', // Lingo Name Table
    LSCR: 'Lscr', // Lingo Script Bytecode
    LSCR_UPPER: 'LSCR',
    LCTX: 'LctX', // Lingo Context (Metadata)
    VWFT: 'VWFT', // Vector Font
    FONT: 'FONT', // Standard Font
    CLUT: 'CLUT', // Palette (Color Lookup Table)
    BITD: 'BITD', // Bitmap Data
    SND: 'SND ',  // Sound (Stereo/Mono PCM)
    snd: 'snd ',  // Sound (Platform-specific lowercase)
    SND_STAR: 'SND*', // Sound Variant
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
    VWSC: 'VWSC',  // Score (Dir 4+)
    FVER: 'Fver',  // File Version
    FMAP: 'Fmap',  // Logical to Physical Map
    FCDR: 'Fcdr',  // File Catalog Directory
    ABMP: 'Abmp',  // Asset Bitmap/Map
    FGEI: 'FGEI',  // Inline Resource Header
    CDGF: 'CDGF',  // Reversed FGDC
    MDGF: 'MDGF',  // Reversed FGDM
    FGDM: 'FGDM',  // Compressed Afterburner (Variant)
    DIB: 'DIB ',  // Device Independent Bitmap
    DIB_STAR: 'DIB*', // Alternate DIB
    PMBA: 'PMBA',  // Protected Abmp
    ILBM: 'ILBM',  // Interleaved Bitmap
    VCSH: 'VCSH',  // Vector Shape payload
    // Internal Map Tags
    imap: 'imap',
    mmap: 'mmap',
    pami: 'pami',
    pamm: 'pamm',
    // Additional Variants from Audit
    CAS_STAR: 'CAS*',
    cas_star: 'cas*',
    CArT: 'CArT',
    CAsT: 'CAsT',
    cast_lower: 'cast',
    CLUT_UPPER: 'CLUT',
    clut_lower: 'clut',
    Palt: 'Palt',
    palt_lower: 'palt',
    PALT_UPPER: 'PALT',
    medi: 'medi',
    ediM: 'ediM',
    bitd_lower: 'bitd',
    stxt_lower: 'stxt',
    text_lower: 'text',
    abmc: 'abmc',
    manL: 'manL',
    XTCL: 'XTCL',
    LCTX_UPPER: 'LCTX',
    Lctx: 'Lctx',
    lctx_lower: 'lctx',
    PIXL: 'PIXL',
    rcsL: 'rcsL',
    ILS: 'ILS ',
    ILS_REV: ' ,i',
    // Legacy Media Types
    MooV: 'MooV',
    VdM: 'VdM ',
    Flas: 'Flas',
    MCrs: 'MCrs',
    PICT: 'PICT',
    FX_STAR: 'Fx*',

    // Afterburner Inline
    IEGF: 'IEGF',
    junk: 'junk',
    free: 'free'
};
