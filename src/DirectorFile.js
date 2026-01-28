/**
 * @version 1.2.7
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
            await this._autoDetectEndianness();
        } catch (e) {
            this.log('ERROR', `Failed to calculate afterburned structure: ${e.message}`);
            throw e;
        }
    }

    async _autoDetectEndianness() {
        // Heuristic: Check Lnam or Key* chunk for sanity
        const lnam = this.chunks.find(c => DirectorFile.unprotect(c.type) === 'Lnam');
        if (lnam) {
            const data = await this.getChunkData(lnam);
            if (data && data.length >= 16) {
                const ds = new DataStream(data, this.ds.endianness);
                ds.readInt32(); // unk0
                ds.readInt32(); // unk1
                const len1 = ds.readUint32();
                // If len1 is absurdly large relative to buffer, wrong endianness
                if (len1 > data.length + 10000 && len1 > 0x100000) {
                    const oldEndian = this.ds.endianness;
                    this.ds.endianness = (oldEndian === 'big') ? 'little' : 'big';
                    this.log('INFO', `Auto-detected endianness mismatch. Switched from ${oldEndian} to ${this.ds.endianness}.`);

                    // Re-check to be sure?
                    ds.endianness = this.ds.endianness;
                    ds.seek(8);
                    const len1New = ds.readUint32();

                }
            }
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
            const entryCount = fcdrDS.readUint16();

            for (let i = 0; i < entryCount; i++) {
                const tag = fcdrDS.readFourCC();
                const len = fcdrDS.readUint32();
                const off = fcdrDS.readUint32();
                fcdrDS.readUint32(); // Unknown/Flags
                if (off > 0) {
                    this.chunks.push({ type: DirectorFile.unprotect(tag), len, off, id: i });
                }
            }

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
            abmpDS.readVarInt(); // v1
            abmpDS.readVarInt(); // v2
            const resCount = abmpDS.readVarInt();

            // Read entries with inline tags
            for (let i = 0; i < resCount; i++) {
                const resId = abmpDS.readVarInt();
                const offset = abmpDS.readVarInt();
                const compSize = abmpDS.readVarInt();
                const uncompSize = abmpDS.readVarInt();
                const compTypeIdx = abmpDS.readVarInt();
                const rawTag = abmpDS.readFourCC();
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

    async loadInlineStream(ilsInfo) {
        try {
            const decomp = await this.getChunkData(ilsInfo);
            if (!decomp) return;
            const ilsDS = new DataStream(decomp, this.ds.endianness);

            while (ilsDS.position < ilsDS.buffer.length) {
                const resId = ilsDS.readVarInt();
                const chunkInfo = this.chunks.find(c => c.id === resId);

                if (chunkInfo) {
                    if (chunkInfo.len > Limits.InternalStreamSafetyLimit) break;
                    if (ilsDS.position + chunkInfo.len > ilsDS.buffer.length) break;

                    this.cachedViews[resId] = ilsDS.readBytes(chunkInfo.len);
                } else {
                    // Abmp should be authoritative. If we hit an ID not in Abmp with unknown len, we are stuck.
                    break;
                }
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
            if (this.format === 'afterburner') {
                this.ds.seek(this.ilsBodyOffset + chunk.off);
                const raw = this.ds.readBytes(chunk.len);
                if (chunk.compType === 1 || chunk.uncompLen > chunk.len) {
                    try {
                        data = zlib.inflateSync(raw);
                    } catch (e) {
                        try {
                            data = zlib.inflateRawSync(raw);
                        } catch (e2) {
                            try {
                                if (raw.length > 4) {
                                    data = zlib.inflateRawSync(raw.slice(4));
                                } else {
                                    throw e2;
                                }
                            } catch (e3) {
                                data = raw;
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
