/**
 * @version 1.3.5
 * Offsets.js - Binary structure offsets for Director chunks
 */

module.exports = {
    KeyTableStandard: 20,
    KeyTableShort: 12,
    KeyEntryStandard: 12,
    KeyEntryShort: 8,
    Cast: {
        HeaderSize: 12,
        SlotId: 12,
        CommonInfoOffset: 4,
        TypeSpecOffset: 8
    },
    DirConfig: {
        DirectorVersion: 36,
        FrameRate: 54,
        Platform: 56,
        Protection: 58,
        Checksum: 64
    }
};
