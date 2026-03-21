/**
 * @version 1.4.2
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
    'STG ': 'Grid', // Grid (Shockwave)
    'CDGF': 'FGDC', // Reversed FGDC (Little Endian)
    'MDGF': 'FGDM', // Reversed FGDM (Little Endian)
    'revF': 'Fver', // Reversed Fver
    'pamF': 'Fmap', // Reversed Fmap
    'rdcF': 'Fcdr', // Reversed Fcdr
    'FCRD': 'DRCF', // Reversed DRCF
    'pmbA': 'Abmp', // Reversed ABMP
    'IEGF': 'FGEI', // Reversed FGEI
    'abmc': 'MCsL', // Afterburner MCsL
    'cas*': 'CASt', // Lowercase Protected CASt
    '*SAC': 'CASt', // Reversed CASt
    'clut': 'CLUT',
    'Palt': 'CLUT',
    'palt': 'CLUT',
    'PALT': 'CLUT',
    'TULC': 'CLUT', // Reversed CLUT
    'bitd': 'BITD',
    'DTIB': 'BITD', // Reversed BITD
    'AFLA': 'ALFA', // Reversed ALFA
    'stxt': 'STXT',
    'TXTS': 'STXT'
};
