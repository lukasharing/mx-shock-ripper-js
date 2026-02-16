/**
 * @version 1.3.8
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
        FilenameSanitize: /[\/\\?%*:|"<>\s]/g,
        TextExtMatch: /\.(props|txt|json|xml|html|css|js|ls|lsc)$/i
    },
    Formats: {
        PNG: 'png',
        WAV: 'wav',
        RTF: 'rtf',
        LS: 'ls',
        LASM: 'lasm',
        DAT: 'dat',
        SVG: 'svg',
        FNT: 'fnt',
        PAL: 'pal',
        JSON: 'json',
        IMA4: 'ima4',
        MP3: 'mp3',
        SWA: 'swa',
        RAW: 'raw',
        TWOS: 'twos',
        MACE: 'mace',
        UNKNOWN: 'unknown',
        OTF: 'otf',
        TTF: 'ttf'
    }
};
