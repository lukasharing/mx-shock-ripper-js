/** @version 1.0.0 - Made by @lukasharing github: https://github.com/lukasharing */
const GenericExtractor = require('./GenericExtractor');
const { Resources: { FileExtensions }, Sound: { Signatures: SoundSignatures } } = require('../Constants');

/**
 * @version 1.1.9
 * SoundExtractor - Handles extraction and conversion of Director 
 * sound (SND) assets.
 * 
 * See docs/doc/07_SoundExtraction.md for technical details.
 */
class SoundExtractor extends GenericExtractor {
    constructor(logger) {
        super(logger);
    }

    /**
     * Detect sound format and return appropriate extension
     */
    getExtensions(buffer) {
        if (!buffer || buffer.length < 4) return FileExtensions.Sound;

        // Check for MP3 (ID3 tag or sync frame)
        const id3 = SoundSignatures.MP3_ID3;
        if (buffer[0] === id3[0] && buffer[1] === id3[1] && buffer[2] === id3[2]) {
            return FileExtensions.MP3;
        }

        // MP3 Sync Frame: 0xFF followed by 0xE0, 0xF2, 0xFB, etc.
        if (buffer[0] === SoundSignatures.MP3_SYNC && (buffer[1] & 0xE0) === 0xE0) {
            return FileExtensions.MP3;
        }

        // Check for WAV (RIFF)
        if (buffer.slice(0, 4).toString() === SoundSignatures.RIFF) {
            return FileExtensions.WAV;
        }

        return FileExtensions.Sound;
    }

    /**
     * Parse Director SND header and return metadata
     * Based on ProjectorRays/src/director/sound.cpp
     */
    parseSndHeader(buffer) {
        if (!buffer || buffer.length < 20) return null;

        // 1. Check for medi (Xmedia) / SWA header
        const swaMeta = this._parseSwaHeader(buffer);
        if (swaMeta) return swaMeta;

        // 2. Parse Sound Command and Header Record (Standard/Extended)
        return this._parseGenericHeader(buffer);
    }

    /**
     * Internal: Handles Xmedia/SWA specific header parsing.
     */
    _parseSwaHeader(buffer) {
        const firstUint = buffer.readUInt32BE(0);
        const isSwa = firstUint === SoundSignatures.SWA_MAGIC ||
            (buffer.length > 40 && buffer.slice(36, 40).toString() === SoundSignatures.MACR);

        if (!isSwa) return null;

        const sampleRate = buffer.readUInt32BE(8);
        // SWA often starts at 320 or 324
        let dataOffset = 320;
        if (buffer.length > 324 && buffer[320] === 0 && buffer[321] === 0 && buffer[322] === 0 && buffer[323] === 0) {
            dataOffset = 324;
        }

        // Check for MP3 sync word at the offset
        const isMp3 = buffer.length > dataOffset + 2 &&
            buffer[dataOffset] === 0xFF &&
            (buffer[dataOffset + 1] & 0xE0) === 0xE0;

        return {
            format: isMp3 ? 'mp3' : 'swa',
            dataOffset,
            sampleRate,
            numChannels: 1, // Default, SWA can be stereo but samples are usually mono
            sampleSize: 16,
            numSamples: 0
        };
    }

    /**
     * Internal: Handles standard and extended Director sound headers.
     */
    _parseGenericHeader(buffer) {
        let pos = 0;
        const format = buffer.readUInt16BE(pos);
        pos += 2;

        if (format === 1) {
            const dataFormatCount = buffer.readUInt16BE(pos);
            pos += 2 + (dataFormatCount * 6);
        } else if (format === 2) {
            pos += 2; // referenceCount
        } else {
            return null;
        }

        if (pos + 2 > buffer.length) return null;
        const soundCommandCount = buffer.readUInt16BE(pos);
        pos += 2 + (soundCommandCount * 8);

        // Sound header record (22 bytes min)
        if (pos + 22 > buffer.length) return null;

        const sampleRateFixed = buffer.readUInt32BE(pos + 8);
        const sampleRate = sampleRateFixed >>> 16;
        const encode = buffer.readUInt8(pos + 20);

        let numChannels = 1;
        let sampleSize = 8;
        let numSamples = 0;
        let dataOffset = pos + 22;

        if (encode === 0x00) {
            // Standard header: numSamples for 8-bit mono
            numSamples = buffer.readUInt32BE(pos + 4);
        } else if (encode === 0xFF || encode === 0xFD) {
            // Extended header: Includes channels and AIFF-like attributes
            numChannels = buffer.readUInt32BE(pos + 4);
            if (pos + 66 <= buffer.length) {
                numSamples = buffer.readUInt32BE(pos + 22);
                sampleSize = buffer.readUInt16BE(pos + 60);
                dataOffset = pos + 66;
            }
        }

        // skipSamples: Skip potential padding/metadata before raw PCM
        if (dataOffset + 4 <= buffer.length) dataOffset += 4;

        return { dataOffset, sampleRate, numChannels, sampleSize, numSamples };
    }

    /**
     * Generate a WAV header for raw PCM data
     */
    generateWavHeader(dataSize, sampleRate, numChannels, sampleSize) {
        const header = Buffer.alloc(44);

        // RIFF Chunk
        header.write(SoundSignatures.RIFF, 0);
        header.writeUInt32LE(36 + dataSize, 4);
        header.write(SoundSignatures.WAVE, 8);

        // fmt Subchunk
        header.write('fmt ', 12);
        header.writeUInt32LE(16, 16);
        header.writeUInt16LE(1, 20); // PCM format
        header.writeUInt16LE(numChannels, 22);
        header.writeUInt32LE(sampleRate, 24);

        const byteRate = sampleRate * numChannels * (sampleSize / 8);
        const blockAlign = numChannels * (sampleSize / 8);

        header.writeUInt32LE(byteRate, 28);
        header.writeUInt16LE(blockAlign, 32);
        header.writeUInt16LE(sampleSize, 34);

        // data Subchunk
        header.write('data', 36);
        header.writeUInt32LE(dataSize, 40);

        return header;
    }

    /**
     * Save sound data to a file
     */
    save(buffer, outputPath, member) {
        if (!buffer) return false;

        // Extract metadata from Director SND chunk
        const metadata = this.parseSndHeader(buffer);

        let finalData = buffer;
        let ext = FileExtensions.Sound;

        if (metadata && metadata.dataOffset < buffer.length) {
            const rawData = buffer.slice(metadata.dataOffset);

            if (metadata.format === 'mp3') {
                finalData = rawData;
                ext = FileExtensions.MP3;
            } else {
                // Check if it's already a known format
                ext = this.getExtensions(rawData);

                if (ext === FileExtensions.Sound) {
                    // Not a known format, wrap in WAV if we have metadata
                    if (metadata.sampleRate > 0) {
                        const wavHeader = this.generateWavHeader(
                            rawData.length,
                            metadata.sampleRate,
                            metadata.numChannels,
                            metadata.sampleSize
                        );
                        finalData = Buffer.concat([wavHeader, rawData]);
                        ext = FileExtensions.WAV;
                    } else {
                        finalData = rawData;
                    }
                } else {
                    finalData = rawData;
                }
            }
        } else {
            // Fallback: check whole buffer
            ext = this.getExtensions(buffer);
        }

        const finalPath = outputPath.endsWith(ext) ? outputPath : outputPath + ext;
        const result = this.saveFile(finalData, finalPath, "sound");

        if (result) {
            return {
                soundFile: result.file,
                soundSize: result.size,
                extension: ext,
                metadata: metadata
            };
        }
        return false;
    }
}

module.exports = SoundExtractor;
