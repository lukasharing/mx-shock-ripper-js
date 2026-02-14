const fs = require('fs');
const path = require('path');
const DataStream = require('../utils/DataStream');
const { Magic, Offsets } = require('../Constants');

class MovieProcessor {
    constructor(extractor) {
        this.extractor = extractor;
    }

    async extractConfig() {
        const configTags = [Magic.VWSC, Magic.VWCF, 'conf', 'VWky', Magic.DRCF];
        const chunk = this.extractor.dirFile.chunks.find(c => configTags.includes(c.type));
        if (!chunk) return;

        const isMovie = [Magic.MV93, Magic.MVPV].includes(this.extractor.dirFile.subtype) ||
            this.extractor.dirFile.chunks.some(c => [Magic.VWSC, Magic.SCORE, Magic.MCsL, Magic.Lscl].includes(c.type));

        if (!isMovie) return;

        const data = await this.extractor.dirFile.getChunkData(chunk);
        if (!data) return;

        const ds = new DataStream(data, 'big');
        const len = ds.readInt16();
        const fileVer = ds.readInt16();
        this.extractor.log('INFO', `[MovieProcessor] DRCF Version: ${fileVer}`);
        const stage = { top: ds.readInt16(), left: ds.readInt16(), bottom: ds.readInt16(), right: ds.readInt16() };

        const minMember = ds.readInt16();
        const maxMember = ds.readInt16();

        ds.seek(36);
        const dirVer = ds.readInt16();
        const ver = dirVer;
        const verNum = parseInt(String(ver).replace(/\./g, '')) || 0;

        let stageColor = "#FFFFFF";
        if (verNum < 700) {
            ds.seek(26);
            const paletteIdx = ds.readInt16();
            stageColor = `Palette Index ${paletteIdx}`;
        } else {
            ds.seek(18);
            const g = ds.readUint8();
            const b = ds.readUint8();
            ds.seek(26);
            const isRGB = ds.readUint8();
            const r = ds.readUint8();
            if (isRGB) {
                stageColor = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`.toUpperCase();
            } else {
                stageColor = `Palette Index ${r}`;
            }
        }

        ds.seek(28);
        const bitDepth = ds.readInt16();

        ds.seek(Offsets.DirConfig.FrameRate || 54);
        const frameRate = ds.readInt16();
        const platformId = ds.readInt16();
        const protectionVal = ds.readInt16();

        const platformMap = { "-1": "Macintosh", "1024": "Windows" };
        const platform = platformMap[platformId] || `Unknown (${platformId})`;
        const protection = (protectionVal % 23 === 0) ? "Protected" : "None";

        this.extractor.metadata.movie = {
            fileVersion: fileVer,
            directorVersion: dirVer,
            humanVersion: ver,
            stageRect: stage,
            frameRate,
            bitDepth,
            stageColor,
            platform,
            protection,
            minMember,
            maxMember
        };
        this.extractor.bitmapExtractor.fileVersion = fileVer;
        fs.writeFileSync(path.join(this.extractor.outputDir, 'movie.json'), JSON.stringify(this.extractor.metadata.movie, null, 2));
    }

    async extractTimeline() {
        const scoreChunk = this.extractor.dirFile.chunks.find(c => c.type === Magic.VWSC || c.type === Magic.SCORE);
        if (!scoreChunk) return;

        const data = await this.extractor.dirFile.getChunkData(scoreChunk);
        if (!data) return;

        const timeline = {
            frameCount: 0,
            markers: [],
            scoreChunk: { id: scoreChunk.id, type: scoreChunk.type, size: data.length }
        };

        const ds = new DataStream(data, 'big');
        try {
            if (scoreChunk.type === Magic.VWSC) {
                ds.seek(4);
                timeline.frameCount = ds.readUint32();
                const labelsOffset = ds.readUint32();
                if (labelsOffset > 0 && labelsOffset < data.length) {
                    ds.seek(labelsOffset);
                    const labelCount = ds.readUint16();
                    for (let i = 0; i < labelCount; i++) {
                        if (ds.position + 3 > data.length) break;
                        const frame = ds.readUint16();
                        const nameLen = ds.readUint8();
                        const name = ds.readString(nameLen);
                        timeline.markers.push({ frame, name });
                    }
                }
            } else if (scoreChunk.type === Magic.SCORE) {
                ds.seek(12);
                const labelsOffset = ds.readUint32();
                if (labelsOffset > 0 && labelsOffset < data.length) {
                    ds.seek(labelsOffset);
                    const labelCount = ds.readUint16();
                    for (let i = 0; i < labelCount; i++) {
                        if (ds.position + 3 > data.length) break;
                        const frame = ds.readUint16();
                        const nameLen = ds.readUint8();
                        const name = ds.readString(nameLen);
                        timeline.markers.push({ frame, name });
                    }
                }
            }
        } catch (e) {
            this.extractor.log('WARN', `Failed to parse timeline details: ${e.message}`);
        }
        fs.writeFileSync(path.join(this.extractor.outputDir, 'timeline.json'), JSON.stringify(timeline, null, 2));
    }

    async extractCastList() {
        const chunk = this.extractor.dirFile.chunks.find(c => c.type === Magic.MCsL || c.type === Magic.Lscl);
        if (!chunk) return;

        const data = await this.extractor.dirFile.getChunkData(chunk);
        if (!data) return;

        const ds = new DataStream(data, 'big');
        const dataOffset = ds.readUint32();
        if (dataOffset >= data.length) {
            this.extractor.log('WARN', `Invalid cast list data offset: ${dataOffset}. Skipping cast extraction.`);
            return;
        }
        ds.skip(2);
        const castCount = ds.readUint16();
        const itemsPerCast = ds.readUint16();

        if (castCount === 0 || itemsPerCast === 0) return;

        ds.seek(dataOffset);
        const offsetTableLen = ds.readUint16();
        const offsets = [];
        for (let i = 0; i < offsetTableLen; i++) offsets.push(ds.readUint32());

        const itemsLen = ds.readUint32();
        const itemsBase = ds.position;

        const readItem = (idx) => {
            if (idx >= offsets.length) return null;
            const start = offsets[idx], end = (idx + 1 < offsets.length) ? offsets[idx + 1] : itemsLen;
            if (start >= end) return null;
            const itemData = data.slice(itemsBase + start, itemsBase + end);
            if (itemData.length === 0) return "";
            const len = itemData[0];
            if (len > 0 && len < itemData.length) return itemData.slice(1, 1 + len).toString('utf8');
            return itemData.toString('utf8').replace(/\0/g, '').trim();
        };

        const castList = [];
        const actualCastCount = Math.floor(offsetTableLen / itemsPerCast);
        const preloadMap = { 0: "Never", 1: "When Needed", 2: "Before Frame 1", 3: "After Frame 1" };

        for (let i = 0; i < actualCastCount; i++) {
            let name = readItem(i * itemsPerCast + 1) || "Unnamed Cast";
            let pathStr = readItem(i * itemsPerCast + 2) || "";
            let preloadMode = "When Needed";
            const preloadIdx = i * itemsPerCast + 3;
            if (preloadIdx < offsetTableLen) {
                const pData = data.slice(itemsBase + offsets[preloadIdx], itemsBase + (offsets[preloadIdx + 1] || itemsLen));
                if (pData.length >= 2) preloadMode = preloadMap[pData.readUInt16BE(0)] || `Unknown (${pData.readUInt16BE(0)})`;
            }
            if (name.includes('\\') || name.includes('/') || name.toLowerCase().endsWith('.cst') || name.toLowerCase().endsWith('.cct')) {
                if (!pathStr) pathStr = name;
                name = path.basename(name.replace(/\\/g, '/')).replace(/\.(cst|cct|dcr|dir)$/i, '');
            }
            if (pathStr && (pathStr.includes('\\') || pathStr.includes('/')) && !pathStr.toLowerCase().match(/\.(cst|cct|dcr|dir)$/)) pathStr += '.cst';
            if (name.toLowerCase() === 'internal') continue;
            castList.push({ index: i + 1, name, path: pathStr, preloadMode });
        }

        if (castList.length > 0) this.extractor.castLibs = castList;
    }
}

module.exports = MovieProcessor;
