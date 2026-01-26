/**
 * @version 1.1.2
 * SoundExtractor.js - Strategic extraction of Director audio assets
 * 
 * Supports SWA (Shockwave Audio/MP3) and raw PCM formats. Implements 
 * automatic RIFF/WAV header reconstruction for uncompressed samples.
 */

const fs = require('fs');
const GenericExtractor = require('./GenericExtractor');

const { Sound: { Signatures } } = require('../Constants');

class SoundExtractor extends GenericExtractor {
    constructor(logger) {
        super(logger);
    }

    /**
     * Extracts sound data, detecting if it needs internal reconstruction (WAV) or 
     * if it's already a compressed stream (MP3/SWA).
     */
    save(buffer, outputPath, member) {
        if (!buffer || buffer.length === 0) return null;

        const metadata = this._parseSndHeader(buffer);
        let finalData = buffer;
        let ext = '.snd';

        if (metadata && metadata.dataOffset < buffer.length) {
            const raw = buffer.slice(metadata.dataOffset);

            if (metadata.isMp3 || this._isMp3(raw)) {
                finalData = raw;
                ext = '.mp3';
            } else if (metadata.sampleRate > 0) {
                finalData = this._wrapWav(raw, metadata);
                ext = '.wav';
            } else {
                finalData = raw;
            }
        } else if (this._isMp3(buffer)) {
            ext = '.mp3';
        }

        const finalPath = outputPath.endsWith(ext) ? outputPath : outputPath + ext;
        fs.writeFileSync(finalPath, finalData);
        return { path: finalPath, size: finalData.length };
    }

    _isMp3(buffer) {
        if (buffer[0] === Signatures.MP3_ID3[0] && buffer[1] === Signatures.MP3_ID3[1]) return true;
        return (buffer[0] === 0xFF && (buffer[1] & 0xE0) === 0xE0); // MP3 Sync Frame
    }

    _parseSndHeader(buffer) {
        if (buffer.length < 20) return null;

        // Handle Shockwave/SWA (MP3 inside SWA wrapper)
        if (buffer.readUInt32BE(0) === Signatures.SWA_MAGIC) {
            return { isMp3: true, dataOffset: 320, sampleRate: buffer.readUInt32BE(8) };
        }

        // Generic Director SND Header (Big Endian)
        try {
            let pos = 0;
            const format = buffer.readUInt16BE(pos); pos += 2;
            if (format === 1) pos += 2 + (buffer.readUInt16BE(pos) * 6);
            else if (format === 2) pos += 2;

            const cmdCount = buffer.readUInt16BE(pos); pos += 2;
            pos += cmdCount * 8; // Skip sound commands

            const sampleRate = buffer.readUInt32BE(pos + 8) >>> 16;
            const encoding = buffer.readUInt8(pos + 20);

            let dataOffset = pos + 22;
            let sampleSize = 8;
            let channels = 1;

            if (encoding === 0xFF || encoding === 0xFD) { // Extended header
                channels = buffer.readUInt32BE(pos + 4);
                sampleSize = buffer.readUInt16BE(pos + 60);
                dataOffset = pos + 66;
            }

            return { sampleRate, channels, sampleSize, dataOffset: dataOffset + 4 };
        } catch (e) {
            return null;
        }
    }

    _wrapWav(data, meta) {
        const header = Buffer.alloc(44);
        header.write(Signatures.RIFF, 0);
        header.writeUInt32LE(36 + data.length, 4);
        header.write(Signatures.WAVE, 8);
        header.write('fmt ', 12);
        header.writeUInt32LE(16, 16);
        header.writeUInt16LE(1, 20); // PCM
        header.writeUInt16LE(meta.channels || 1, 22);
        header.writeUInt32LE(meta.sampleRate, 24);
        header.writeUInt32LE(meta.sampleRate * (meta.channels || 1) * ((meta.sampleSize || 8) / 8), 28);
        header.writeUInt16LE((meta.channels || 1) * ((meta.sampleSize || 8) / 8), 32);
        header.writeUInt16LE(meta.sampleSize || 8, 34);
        header.write('data', 36);
        header.writeUInt32LE(data.length, 40);
        return Buffer.concat([header, data]);
    }
}

module.exports = SoundExtractor;
