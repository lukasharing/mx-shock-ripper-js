/**
 * @version 1.2.0
 * SoundExtractor.js - Handles extraction and conversion of Director 
 * sound (SND) assets. Supports SWA, MP3, and standard PCM.
 */
const GenericExtractor = require('./GenericExtractor');
const DataStream = require('../utils/DataStream');
const { Resources: { FileExtensions }, Sound: { Signatures: SoundSignatures, Codecs: SoundCodecs } } = require('../Constants');

class SoundExtractor extends GenericExtractor {
    constructor(logger) {
        super(logger);
    }

    /**
     * Main entry point for saving sound assets.
     */
    save(buffer, outputPath, member) {
        if (!buffer || buffer.length === 0) return false;

        const meta = this.detectFormat(buffer);
        let finalData = buffer;
        let ext = FileExtensions.Sound;

        // 1. MP3 / SWA (Shockwave Audio)
        if (meta.format === 'mp3' || meta.format === 'swa') {
            finalData = this.stripSWAHeader(buffer, meta.offset);
            ext = FileExtensions.MP3;
        }
        // 2. IMA ADPCM (QuickTime / Apple IMA4)
        else if (meta.format === 'ima4') {
            // TODO: Wrap in AIFC or Decode to WAV. For now, export raw with extension.
            // Many players can play raw .ima4 if renamed to .aifc providing it has a header, 
            // but here we just dump the data chunk.
            if (meta.offset > 0) finalData = buffer.slice(meta.offset);
            ext = '.ima4';
        }
        // 3. Standard PCM (Mac 'raw ' or 'twos')
        else if (meta.format === 'raw' || meta.format === 'twos' || meta.sampleRate > 0) {
            if (meta.offset > 0) {
                const rawData = buffer.slice(meta.offset);
                const sampleSize = meta.sampleSize || 8;
                const channels = meta.numChannels || 1;
                // Generate WAV Header
                const wavHeader = this.generateWavHeader(
                    rawData.length,
                    meta.sampleRate,
                    channels,
                    sampleSize
                );
                finalData = Buffer.concat([wavHeader, rawData]);
                ext = FileExtensions.WAV;
            }
        }

        const finalPath = outputPath.endsWith(ext) ? outputPath : outputPath + ext;
        const result = this.saveFile(finalData, finalPath, `sound (${ext})`);

        if (result) {
            return {
                soundFile: result.file,
                soundSize: result.size,
                extension: ext,
                metadata: meta
            };
        }
        return false;
    }

    /**
     * Analyzes the buffer to determine audio format and data offset.
     */
    detectFormat(buffer) {
        if (buffer.length < 32) return { format: 'unknown', offset: 0 };

        const ds = new DataStream(buffer, 'big');
        const signatures = SoundSignatures;

        // Check for SWA / MP3 Signature
        const firstUint = ds.readUint32();
        if (firstUint === signatures.SWA_MAGIC || buffer.slice(0, 4).toString() === 'PTVw') {
            return { format: 'swa', offset: 0 }; // Offset calculated later
        }

        // Check for RIFF (WAV)
        if (buffer.slice(0, 4).toString() === signatures.RIFF) {
            return { format: 'wav', offset: 0 };
        }

        // Parse Director 'snd ' Resource
        ds.seek(0);
        return this.parseDirectorSnd(ds);
    }

    /**
     * Parses Macintosh 'snd ' resource structure.
     */
    parseDirectorSnd(ds) {
        const meta = { format: 'unknown', offset: 0, sampleRate: 0, numChannels: 1, sampleSize: 8 };

        try {
            const format = ds.readUint16(); // Format 1 or 2

            // Handle Format 1 (Standard)
            if (format === 1) {
                const dataTypeCount = ds.readUint16();
                if (dataTypeCount < 1 || dataTypeCount > 10) return meta; // Sanity check

                // Read Data Types (Codecs)
                for (let i = 0; i < dataTypeCount; i++) {
                    const dataFormatID = ds.readUint32(); // FourCC
                    ds.readUint32(); // initOption

                    if (dataFormatID === SoundCodecs.IMA4) meta.format = 'ima4';
                    else if (dataFormatID === SoundCodecs.TWOS) meta.format = 'twos'; // 16-bit
                    else if (dataFormatID === SoundCodecs.RAW) meta.format = 'raw';   // 8-bit
                    else if (dataFormatID === SoundCodecs.MAC3 || dataFormatID === SoundCodecs.MAC6) meta.format = 'mace';
                }
            } else if (format === 2) {
                ds.readUint16(); // refCount
            } else {
                return meta; // Not a valid snd
            }

            // Parse Commands (SoundCommandCount)
            const cmdCount = ds.readUint16();
            ds.skip(cmdCount * 8); // Skip commands (cmd: 2, param1: 2, param2: 4)

            // Parse Sound Header Record unless EOF
            if (ds.position + 22 <= ds.byteLength) {
                ds.readUint32(); // samplePtr
                ds.readUint32(); // headerEncode (OR reserved)

                // Fixed Point 16.16 Sample Rate
                const srHi = ds.readUint16();
                const srLo = ds.readUint16(); // fraction
                meta.sampleRate = srHi; // Ignore fraction for standard extraction

                ds.readUint32(); // loopStart
                ds.readUint32(); // loopEnd

                const encode = ds.readUint8();
                ds.readUint8(); // baseFrequency

                // Extended Header Detection
                if (encode === 0xFF || encode === 0xFD) {
                    // Extended Sound Header
                    ds.readUint32(); // numSamples
                    ds.skip(10); // AIFFSampleRate (80-bit float) or similar
                    ds.skip(12); // marker, instrument, AES

                    meta.numChannels = ds.readUint32();
                    meta.sampleSize = ds.readUint16();
                    // ... future use fields
                } else if (encode === 0) {
                    // Standard Sound Header
                    meta.numChannels = 1;
                    meta.sampleSize = 8;
                }

                // If MP3/SWA is embedded in 'snd ' (common in Director 6+ compressed)
                // it might not obey the 'encode' flag strictly, but rely on 'ima4' or just raw data.
                // Scan for MP3 sync if not ima4
                if (meta.format !== 'ima4') {
                    // Peek ahead for MP3 sync
                    const currentPos = ds.position;
                    // Usually data starts here or after a few null bytes
                    const sync = this.findMP3Sync(ds.buffer.slice(currentPos, currentPos + 128));
                    if (sync !== -1) {
                        meta.format = 'mp3';
                        meta.offset = currentPos + sync;
                        return meta;
                    }
                }

                meta.offset = ds.position;
            }

        } catch (e) {
            // Ignore parse errors, fallback to raw
        }

        return meta;
    }

    /**
     * Looks for Frame Sync (0xFF followed by 0xE0-0xFF usually)
     * Returns offset relative to buffer start, or -1
     */
    findMP3Sync(buffer) {
        for (let i = 0; i < buffer.length - 1; i++) {
            if (buffer[i] === 0xFF && (buffer[i + 1] & 0xE0) === 0xE0) {
                return i;
            }
        }
        return -1;
    }

    /**
     * Strips SWA headers to return valid MP3 binary.
     */
    stripSWAHeader(buffer, hintOffset = 0) {
        // Try precise sync search
        const syncPos = this.findMP3Sync(buffer.slice(hintOffset));
        if (syncPos !== -1) {
            return buffer.slice(hintOffset + syncPos);
        }
        // Fallback: Return original
        return buffer;
    }

    generateWavHeader(dataSize, sampleRate, numChannels, sampleSize) {
        const header = Buffer.alloc(44);
        header.write(SoundSignatures.RIFF, 0);
        header.writeUInt32LE(36 + dataSize, 4);
        header.write(SoundSignatures.WAVE, 8);
        header.write('fmt ', 12);
        header.writeUInt32LE(16, 16);
        header.writeUInt16LE(1, 20); // PCM
        header.writeUInt16LE(numChannels, 22);
        header.writeUInt32LE(sampleRate, 24);
        const byteRate = sampleRate * numChannels * (sampleSize / 8);
        const blockAlign = numChannels * (sampleSize / 8);
        header.writeUInt32LE(byteRate, 28);
        header.writeUInt16LE(blockAlign, 32);
        header.writeUInt16LE(sampleSize, 34);
        header.write('data', 36);
        header.writeUInt32LE(dataSize, 40);
        return header;
    }
}

module.exports = SoundExtractor;
