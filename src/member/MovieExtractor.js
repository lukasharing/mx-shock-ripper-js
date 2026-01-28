/**
 * @version 1.2.4
 * MovieExtractor.js - Extraction logic for Movie and FilmLoop members
 * 
 * Handles parsing of internal Score data for FilmLoops (Type 2).
 * Reconstructs the timeline state (channels) from compressed binary data.
 */

const GenericExtractor = require('./GenericExtractor');
const DataStream = require('../utils/DataStream');

class MovieExtractor extends GenericExtractor {
    constructor(log) {
        super(log);
    }

    /**
     * Parses the FilmLoop data (Score format).
     * @param {Buffer} buffer - The raw FilmLoop cast member payload
     * @param {Object} member - The cast member metadata
     */
    extract(buffer, member) {
        if (!buffer || buffer.length < 12) return null;

        const ds = new DataStream(buffer, 'big');

        // FilmLoops usually wrap a Score structure.
        // [2: flags], [8: rect], [2: castFlags?]
        // The data that follows is the actual Score compression.

        try {
            const flags = ds.readUint16();
            const rect = ds.readRect();
            const castFlags = ds.readUint16();

            const scoreData = buffer.slice(ds.position);
            const timeline = this._parseScore(scoreData);

            return JSON.stringify({
                memberId: member.id,
                name: member.name,
                flags,
                bounds: rect,
                castFlags,
                frameCount: timeline.frameCount,
                frames: timeline.frames
            }, null, 2);

        } catch (e) {
            this.log('ERROR', `FilmLoop ${member.id} parsing failed: ${e.message}`);
            return JSON.stringify({ error: e.message, memberId: member.id }, null, 2);
        }
    }

    /**
     * Internal Score parser (supports delta-reconstruction).
     */
    _parseScore(buffer) {
        if (buffer.length < 12) return { frameCount: 0, frames: [] };

        const ds = new DataStream(buffer, 'big');
        const frames = [];

        // Identify Score format (D4 uses VWSC header often embedded, D5+ uses SCORE)
        // Note: FilmLoop payloads usually skip the "SCORE"/"VWSC" FourCC but keep the inner structure.

        // Common header: [4: size][2: version][4: frameCount]
        const size = ds.readUint32();
        const version = ds.readUint16();
        const frameCount = ds.readUint32();

        // The score is stored as a series of frame data blocks.
        // Director uses a delta-compression: 
        // A frame block contains only the changes since the previous frame.

        let currentFrameState = this._createEmptyFrame();

        for (let f = 0; f < frameCount; f++) {
            if (ds.position + 2 > buffer.length) break;

            const frameDataSize = ds.readUint16();
            if (frameDataSize === 0) {
                // No changes, duplicate previous state
                frames.push(JSON.parse(JSON.stringify(currentFrameState)));
                continue;
            }

            const frameEnd = ds.position + frameDataSize;

            // Channel data parsing
            while (ds.position < frameEnd) {
                const channelData = this._readChannelData(ds, version);
                if (channelData) {
                    currentFrameState.channels[channelData.index] = channelData.props;
                }
            }

            ds.seek(frameEnd);
            frames.push(JSON.parse(JSON.stringify(currentFrameState)));
        }

        return { frameCount, frames };
    }

    _createEmptyFrame() {
        return {
            channels: {} // Map of channelIndex -> properties
        };
    }

    _readChannelData(ds, version) {
        // Simplified Channel Parsing
        // Typically [1: channelIndex][1: propFlags][...data]
        // This varies wildly between D4 and D8.5.
        // We implement a heuristic approach for standard properties.

        const channelIndex = ds.readUint8();
        if (channelIndex === 0xFF) return null; // End of frame signal for some versions

        const props = {};

        // Heuristic: Extracting common fields based on observed patterns
        // [2: memberId][2: ink][8: rect]
        if (ds.position + 12 <= ds.buffer.length) {
            props.memberId = ds.readUint16();
            props.ink = ds.readUint8();
            props.blend = ds.readUint8();
            props.rect = ds.readRect();
        }

        return { index: channelIndex, props };
    }

    save(buffer, outputPath, member) {
        if (!buffer) return false;

        // Save JSON representation
        const json = this.extract(buffer, member);
        if (json) {
            return this.saveFile(Buffer.from(json, 'utf8'), outputPath + '.filmloop.json', "FilmLoop (JSON)");
        }
        return false;
    }
}

module.exports = MovieExtractor;
