/**
 * @version 1.3.5
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
    },
    Codecs: {
        MAC3: 0x4D414333, // 'MAC3'
        MAC6: 0x4D414336, // 'MAC6'
        RAW: 0x72617720,  // 'raw '
        TWOS: 0x74776F73, // 'twos'
        IMA4: 0x696D6134, // 'ima4'
        SWA: 'SWA'
    }
};
