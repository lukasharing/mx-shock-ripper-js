/**
 * @version 1.3.5
 * Resources.js - Display labels and file extension mapping
 */

module.exports = {
    FileExtensions: {
        Font: '.font',
        Sound: '.snd',
        MP3: '.mp3',
        WAV: '.wav',
        XMED: '.xmed',
        Script: '.ls',
        JSON: '.json',
        SVG: '.svg',
        Binary: '.bin',
        PNG: '.png'
    },
    Labels: {
        Generic: 'generic',
        Bitmap: 'bitmap',
        Sound: 'sound',
        Script: 'script',
        Palette: 'palette',
        Font: 'font',
        Shape: 'shape',
        Text: 'text',
        Field: 'field',
        Xtra: 'xtra'
    },
    Regex: {
        FilenameSanitize: /[\/\\?%*:|"<>\s]/g
    }
};
