/**
 * @version 1.2.2
 * Afterburner.js - Normalization map for protected FourCC tags
 */

module.exports = {
    'Fver': 'Fver', // File Version
    'Fmap': 'Fmap', // Logical to Physical Map
    'Fcdr': 'Fcdr', // File Catalog Directory
    'Abmp': 'Abmp', // Asset Bitmap/Map
    'FGEI': 'FGEI', // Inline Resource Header
    'pami': 'imap', // Protected imap
    'pamm': 'mmap', // Protected mmap
    '*YEK': 'KEY*', // Protected KEY (byte-swapped)
    'YEK*': 'KEY*', // Protected KEY
    'Lscl': 'MCsL', // Protected Cast List
    'XtcL': 'LctX', // Protected LctX
    'manL': 'Lnam', // Protected Lnam
    'rcsL': 'Lscr', // Protected Lscr
    'CAS*': 'CASt', // Protected CASt
    'snd ': 'SND ', // Lowercase Sound
    'DIB ': 'BITD', // Device Independent Bitmap
    'DIB*': 'BITD', // Alternate DIB
    'SND*': 'SND ', // Protected Sound
    'PMBA': 'Abmp', // Protected Abmp
    'IEGF': 'FGEI', // Protected FGEI
    'ediM': 'medi', // Media (Shockwave)
    'SND ': 'snd ', // Sound (Shockwave)
    'muhT': 'Thum', // Thumbnail (Shockwave)
    'STG ': 'Grid'  // Grid (Shockwave)
};
