/**
 * @version 1.2.2
 * DirectorFile.js - Core logic for parsing .dcr and .cct files.
 */

const fs = require('fs');
const zlib = require('zlib');
const DataStream = require('./utils/DataStream');
const { Magic, AfterburnerTags, Limits } = require('./Constants');

class DirectorFile {
    constructor(buffer, logger) {
        this.ds = buffer ? new DataStream(buffer) : null;
        this.log = logger || ((lvl, msg) => console.log(`[DirectorFile][${lvl}] ${msg}`));
        this.chunks = [];
        this.cachedViews = {};
        this.isAfterburned = false;
        this.ilsBodyOffset = 0;
        this.format = 'unknown';
        this.fmap = null;
        this.subtype = null;
    }

    async open(filePath) {
        if (!fs.existsSync(filePath)) return false;
        try {
            const buffer = fs.readFileSync(filePath);
            this.ds = new DataStream(buffer);
            await this.parse();
            return true;
        } catch (e) {
            this.log('ERROR', `Failed to open file: ${e.message}`);
            return false;
        }
    }

    getChunkById(id) {
        let physicalId = id;
        if (this.fmap && this.fmap[id] !== undefined) {
            physicalId = this.fmap[id];
        }
        return this.chunks.find(c => c.id === physicalId);
    }

    async parse() {
        const magic = this.ds.readFourCC();

        if (magic === Magic.XFIR || magic === 'XFIR') {
            this.ds.endianness = 'little';
            this.format = 'rifx-little';
        } else if (magic === Magic.FGDC || magic === 'FGDC') {
            this.isAfterburned = true;
            this.format = 'afterburner';
        } else if (magic === Magic.RIFX || magic === 'RIFX') {
            this.format = 'rifx-big';
        } else {
            throw new Error(`Unsupported file format: ${magic}`);
        }

        if (this.isAfterburned) {
            await this.calculateAfterburnedStructure();
        } else {
            this.ds.readUint32(); // skip size
            this.subtype = this.ds.readFourCC();

            // Detect hidden Afterburner subtypes
            if ([Magic.FGDC, 'CDGF', 'FGDM', 'MDGF'].includes(this.subtype)) {
                this.isAfterburned = true;
                this.format = 'afterburner';
                await this.calculateAfterburnedStructure();
            } else {
                await this.parseUncompressedStructure();
            }
        }
    }

    async parseUncompressedStructure() {
        let mmapOff = 0;
        this.ds.seek(12);

        while (this.ds.position + 12 < this.ds.buffer.length) {
            const tag = this.ds.readFourCC();
            const len = this.ds.readUint32();

            if (tag === Magic.IMAP || tag === 'IMAP') {
                this.ds.skip(4);
                mmapOff = (this.ds.endianness === 'little') ? this.ds.buffer.readUInt32LE(this.ds.position) : this.ds.buffer.readUInt32BE(this.ds.position);
                break;
            } else if (tag === Magic.MMAP || tag === 'MMAP') {
                mmapOff = this.ds.position - 8;
                break;
            }
            this.ds.skip(Math.max(0, len));
        }

        if (!mmapOff) throw new Error('Failed to locate Memory Map (mmap)');

        this.ds.seek(mmapOff);
        this.ds.readFourCC(); // mmap
        this.ds.readUint32(); // len
        this.ds.skip(4);
        this.ds.readInt32(); // maxChunks
        const usedChunks = this.ds.readInt32();
        this.ds.skip(12);

        for (let i = 0; i < usedChunks; i++) {
            const tag = this.ds.readFourCC();
            const len = this.ds.readUint32();
            const off = this.ds.readUint32();
            this.ds.skip(8);

            if (off > 0) {
                this.chunks.push({ type: tag, len, off, id: i });
            }
        }
    }

    async calculateAfterburnedStructure() {
        try {
            await this._parseFver();
            await this._parseFmap();
            await this._parseFcdr();
            await this._parseAbmp();
            await this._parseFgei();
        } catch (e) {
            this.log('ERROR', `Failed to calculate afterburned structure: ${e.message}`);
            throw e;
        }
    }

    async _parseFver() {
        const tag = DirectorFile.unprotect(this.ds.peekFourCC());
        if (tag === 'Fver') {
            this.ds.readFourCC();
            this.ds.skip(this.ds.readVarInt());
        }
    }

    async _parseFmap() {
        const tag = DirectorFile.unprotect(this.ds.peekFourCC());
        if (tag === 'Fmap') {
            this.ds.readFourCC();
            const fmapLen = this.ds.readVarInt();
            const fmapEnd = this.ds.position + fmapLen;
            this.fmap = {};
            while (this.ds.position < fmapEnd) {
                const logicalId = this.ds.readVarInt();
                const physicalId = this.ds.readVarInt();
                this.fmap[logicalId] = physicalId;
            }
        }
    }

    async _parseFcdr() {
        const tag = DirectorFile.unprotect(this.ds.peekFourCC());
        if (tag === 'Fcdr') {
            this.ds.readFourCC();
            const fcdrLen = this.ds.readVarInt();
            const fcdrDecomp = zlib.inflateSync(this.ds.readBytes(fcdrLen));
            const fcdrDS = new DataStream(fcdrDecomp, this.ds.endianness);
            fcdrDS.skip(fcdrDS.readUint16() * 16);
        }
    }

    async _parseAbmp() {
        const tag = DirectorFile.unprotect(this.ds.peekFourCC());
        if (['Abmp', 'ABMP', 'pmbA'].includes(tag)) {
            this.ds.readFourCC();
            const abmpLen = this.ds.readVarInt();
            const abmpEnd = this.ds.position + abmpLen;
            this.ds.readVarInt(); // skip version?
            this.ds.readVarInt();
            const abmpDecomp = zlib.inflateSync(this.ds.readBytes(abmpEnd - this.ds.position));
            const abmpDS = new DataStream(abmpDecomp, this.ds.endianness);
            abmpDS.readVarInt();
            abmpDS.readVarInt();
            const resCount = abmpDS.readVarInt();
            this.mapAssets(abmpDS, resCount);
        }
    }

    async _parseFgei() {
        const tag = DirectorFile.unprotect(this.ds.peekFourCC());
        if (['FGEI', 'IEGF'].includes(tag)) {
            this.ds.readFourCC();
            this.ds.readVarInt();
            this.ilsBodyOffset = this.ds.position;
            const ilsInfo = this.chunks.find(c => c.id === 2);
            if (ilsInfo) {
                await this.loadInlineStream(ilsInfo);
            }
        }
    }

    mapAssets(ds, count) {
        for (let i = 0; i < count; i++) {
            const resId = ds.readVarInt();
            const offset = ds.readVarInt();
            const compSize = ds.readVarInt();
            const uncompSize = ds.readVarInt();
            const compTypeIdx = ds.readVarInt();
            const rawTag = ds.readFourCC();
            const chunkType = DirectorFile.unprotect(rawTag);

            this.chunks.push({
                type: chunkType,
                len: compSize,
                uncompLen: uncompSize,
                off: offset,
                id: resId,
                compType: compTypeIdx
            });
        }
    }

    async loadInlineStream(ilsInfo) {
        try {
            const ilsDS = new DataStream(zlib.inflateSync(this.ds.readBytes(ilsInfo.len)), this.ds.endianness);
            while (ilsDS.position < ilsDS.buffer.length) {
                const resId = ilsDS.readVarInt();
                const chunkInfo = this.chunks.find(c => c.id === resId);
                if (chunkInfo) {
                    if (chunkInfo.len > Limits.InternalStreamSafetyLimit) break;
                    this.cachedViews[resId] = ilsDS.readBytes(chunkInfo.len);
                } else break;
            }
        } catch (e) {
            this.log('ERROR', `Error decompressing ILS data: ${e.message}`);
        }
    }

    async getChunkData(chunk) {
        if (!chunk) return null;
        if (this.cachedViews[chunk.id]) return this.cachedViews[chunk.id];

        let data;
        try {
            if (this.isAfterburned) {
                this.ds.seek(this.ilsBodyOffset + chunk.off);
                const raw = this.ds.readBytes(chunk.len);
                const isZlib = raw.length > 2 && raw[0] === 0x78 && (raw[1] === 0x9C || raw[1] === 0xDA || raw[1] === 0x01 || raw[1] === 0x5E);

                if (chunk.compType === 1 || isZlib || (chunk.uncompLen > 0 && chunk.uncompLen > chunk.len)) {
                    try {
                        data = zlib.inflateSync(raw);
                    } catch (e) {
                        try {
                            if (raw.length > 4) {
                                data = zlib.inflateSync(raw.slice(4));
                            } else {
                                throw e;
                            }
                        } catch (e2) {
                            try {
                                data = zlib.inflateRawSync(raw);
                            } catch (e3) {
                                try {
                                    if (raw.length > 4) {
                                        data = zlib.inflateRawSync(raw.slice(4));
                                    } else {
                                        throw e3;
                                    }
                                } catch (e4) {
                                    data = raw;
                                }
                            }
                        }
                    }
                } else {
                    data = raw;
                }
            } else {
                this.ds.seek(chunk.off + 8);
                data = this.ds.readBytes(chunk.len);
            }
        } catch (e) {
            this.log('ERROR', `Error reading chunk ${chunk.id} (${chunk.type}): ${e.message}`);
            return null;
        }

        if (data) this.cachedViews[chunk.id] = data;
        return data;
    }

    static unprotect(tag) {
        if (!tag) return tag;
        return AfterburnerTags[tag] || tag;
    }
}

module.exports = DirectorFile;
