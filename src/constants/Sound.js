/**
 * @version 1.1.2
 * Sound.js - Magic numbers and signatures for audio assets
 */

module.exports = {
    Signatures: {
        MP3_ID3: [0x49, 0x44, 0x33],
        MP3_SYNC: 0xFF,
        RIFF: 'RIFF',
        WAVE: 'WAVE',
        SWA_MAGIC: 0x00000140, // 320
        MACR: 'MACR'
    }
};
