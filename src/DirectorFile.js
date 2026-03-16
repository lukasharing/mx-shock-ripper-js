/**
 * @version 1.4.2
 * DirectorFile.js - Core logic for parsing .dcr and .cct files.
 */

const fs = require('fs');
const zlib = require('zlib');
const DataStream = require('./utils/DataStream');
const { Magic, AfterburnerTags, Limits } = require('./Constants');

class DirectorFile {
    constructor(source, logger, length = 0) {
        if (typeof source === 'number') {
            this.ds = new DataStream(source, 'big', length);
            this.fd = source;
        } else {
            this.ds = source ? new DataStream(source) : null;
            this.fd = null;
        }

        this.log = logger || ((lvl, msg) => {
            if (lvl === 'ERROR' || lvl === 'WARN' || lvl === 'WARNING') {
                console.log(`[DirectorFile][${lvl}] ${msg}`);
            }
        });

        this.chunks = [];
        this.cachedViews = {};
        this.isAfterburned = false;
        this.ilsBodyOffset = 0;
        this._ilsBody = null;
        this.format = 'unknown';
        this.fmap = null;
        this.subtype = null;
        this.isLittleEndianFile = false;
        this.chunkIndex = {};
    }

    close() {
        if (this.fd !== null) {
            try {
                fs.closeSync(this.fd);
                this.fd = null;
            } catch (e) {
                this.log('ERROR', `Failed to close file handle: ${e.message}`);
            }
        }
    }

    getChunkById(id) {
        let physicalId = id;
        if (this.fmap && this.fmap[id] !== undefined) {
            physicalId = this.fmap[id];
        }
        const matches = this.chunks.filter(c => c.id === physicalId);
        return matches.length > 0 ? matches[matches.length - 1] : null;
    }

    async parse() {
        if (!this.ds) return;
        const magic = this.ds.readFourCC();
        this.ds.skip(4);

        this.isLittleEndianFile = (magic === Magic.XFIR);
        if (this.isLittleEndianFile) {
            this.ds.endianness = 'little';
            this.format = 'rifx-little';
        } else {
            this.ds.endianness = 'big';
            this.format = 'rifx-big';
        }

        const internalMagic = this.ds.readFourCC();
        this.isAfterburned = [Magic.FGDC, Magic.FGDM, Magic.CDGF, Magic.MDGF].includes(magic) ||
            [Magic.FGDC, Magic.FGDM, Magic.CDGF, Magic.MDGF].includes(internalMagic);

        if (magic === Magic.XFIR || magic === Magic.RIFX) {
            await this.parseUncompressedStructure();
            await this.calculateAfterburnedStructure();
        } else if (this.isAfterburned) {
            this.format = 'afterburner';
            await this.calculateAfterburnedStructure();
        } else {
            throw new Error(`Unsupported file format: ${magic}`);
        }

        this._reindexChunks();
    }

    _reindexChunks() {
        this.chunkIndex = {};
        const types = new Set();
        for (const c of this.chunks) {
            const rawType = c.type || '';
            const type = DirectorFile.unprotect(rawType).toUpperCase(); 
            if (!this.chunkIndex[type]) this.chunkIndex[type] = [];
            this.chunkIndex[type].push(c);
            types.add(type);
        }
    }

    getChunksByType(type) {
        if (!type || typeof type !== 'string') return [];
        const t = type.toUpperCase().trim();
        return this.chunkIndex[t] || [];
    }

    async parseUncompressedStructure() {
        let mmapOff = 0;
        this.ds.seek(12);
        this.subtype = this.ds.readFourCC();
        this.ds.seek(12);
        while (this.ds.position + 12 < this.ds.length) {
            const tag = this.ds.readFourCC();
            const len = this.ds.readUint32();
            if (tag === Magic.IMAP || tag === Magic.imap || tag === Magic.pami) {
                this.ds.skip(4);
                mmapOff = (this.ds.endianness === 'little') ? this.ds.buffer.readUInt32LE(this.ds.position) : this.ds.buffer.readUInt32BE(this.ds.position);
                break;
            } else if (tag === Magic.MMAP || tag === Magic.mmap || tag === Magic.pamm) {
                mmapOff = this.ds.position - 8;
                break;
            }
            this.ds.skip(Math.max(0, len));
        }

        if (!mmapOff) {
            if (this.chunks.length > 0 || this.isAfterburned) return;
            throw new Error(`Failed to locate Memory Map (mmap) in ${this.format} file.`);
        }

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
            let uncompLen = 0, compType = 0, flags = 0, link = 0;
            if (this.isAfterburned) {
                uncompLen = this.ds.readUint32();
                compType = this.ds.readUint32();
            } else {
                flags = this.ds.readUint32();
                link = this.ds.readInt32();
            }
            this.chunks.push({ type: tag, len, off, id: i, uncompLen, compType, flags, link });
        }
    }

    _parseILS() {
        const ds = this.ds;
        ds.seek(8);
        ds.readFourCC(); // ILS 
        ds.readUint32(); // totalLen
        ds.readUint32(); // headerLen
        let count = ds.readUint32();
        if (count > 0xFFFF) {
            this.ds.endianness = this.ds.endianness === 'big' ? 'little' : 'big';
            ds.seek(8 + 4 + 4);
            count = ds.readUint32();
        }
        for (let i = 0; i < count; i++) {
            const tag = ds.readFourCC();
            const len = ds.readUint32();
            const off = ds.readUint32();
            this.chunks.push({ type: tag, len, off, id: i });
        }
    }

    async calculateAfterburnedStructure() {
        try {
            this.ds.seek(12);
            while (this.ds.position + 8 < this.ds.length) {
                const rawTag = this.ds.peekFourCC();
                const tag = DirectorFile.unprotect(rawTag);
                // Director 8.5+ Afterburner stream parsing
                
                if (tag === Magic.FVER) await this._parseFver();
                else if (tag === Magic.FMAP) await this._parseFmap();
                else if (tag === Magic.FCDR) await this._parseFcdr();
                else if (tag === Magic.ABMP || tag === Magic.PMBA) await this._parseAbmp();
                else if (tag === Magic.ILS) this._parseILS();
                else if (tag === Magic.FGEI) {
                    await this._parseFgei();
                    break;
                } else if (tag.length === 4 && /^[a-zA-Z0-9 *]{4}$/.test(tag)) {
                    this.ds.readFourCC();
                    const skipLen = this.ds.readUint32();
                    // skipping unknown chunks
                    this.ds.skip(skipLen);
                } else {
                    this.ds.skip(1);
                }
            }
            await this._autoDetectEndianness();
            if (!this.fmap) {
                const fmapChunk = this.chunks.find(c => DirectorFile.unprotect(c.type).toUpperCase() === Magic.FMAP.toUpperCase());
                if (fmapChunk) {
                    const data = await this.getChunkData(fmapChunk);
                    if (data) {
                        const fmapDS = new DataStream(data, this.ds.endianness);
                        this.fmap = {};
                        while (fmapDS.position < fmapDS.length) {
                            const logicalId = fmapDS.readVarInt();
                            const physicalId = fmapDS.readVarInt();
                            this.fmap[logicalId] = physicalId;
                        }
                    }
                }
            }
        } catch (e) {
            this.log('ERROR', `Afterburner calculation failed: ${e.message}`);
        }
    }

    async _autoDetectEndianness() {
        if (this.isLittleEndianFile) return;
        const checkChunk = this.chunks.find(c => DirectorFile.unprotect(c.type) === Magic.KEY);
        if (checkChunk) {
            const data = await this.getChunkData(checkChunk);
            if (data && data.length >= 12) {
                const ds = new DataStream(data, this.ds.endianness);
                const firstWord = ds.readUint16();
                if (firstWord > 0xFF) this.ds.endianness = (this.ds.endianness === 'big') ? 'little' : 'big';
            }
        }
    }

    async _parseFver() {
        this.ds.readFourCC();
        this.ds.skip(this.ds.readVarInt());
    }

    async _parseFmap() {
        this.ds.readFourCC();
        const len = this.ds.readVarInt();
        const end = this.ds.position + len;
        this.fmap = {};
        while (this.ds.position < end) {
            this.fmap[this.ds.readVarInt()] = this.ds.readVarInt();
        }
    }

    async _parseFcdr() {
        this.ds.readFourCC();
        const len = this.ds.readVarInt();
        const raw = zlib.inflateSync(this.ds.readBytes(len));
        if (raw.slice(0, 10).toString().includes('Macromedia')) return;
        const ds = new DataStream(raw, 'big');
        if (ds.length < 2) return;
        const count = ds.readUint16();
        for (let i = 0; i < count; i++) {
            if (ds.position + 16 > ds.length) break;
            ds.skip(16); // Skip Fcdr entries as they are often garbage in Afterburner
        }
    }

    async _parseAbmp() {
        this.ds.readFourCC();
        const len = this.ds.readVarInt();
        const end = this.ds.position + len;
        const compType = this.ds.readVarInt();
        const uncompLen = this.ds.readVarInt();
        
        const raw = this.ds.readBytes(end - this.ds.position);
        let decomp;
        try {
            decomp = zlib.inflateSync(raw);
        } catch (e) {
            try {
                decomp = zlib.inflateRawSync(raw);
            } catch (e2) {
                this.log('ERROR', `Failed to decompress ABMP: ${e2.message}`);
                return;
            }
        }

        const ds = new DataStream(decomp, this.ds.endianness);
        ds.readVarInt(); // v1
        ds.readVarInt(); // v2
        const resCount = ds.readVarInt();

        for (let i = 0; i < resCount; i++) {
            if (ds.position >= ds.length) break;
            const resId = ds.readVarInt();
            const offset = ds.readVarInt();
            const compSize = ds.readVarInt();
            const uncompSize = ds.readVarInt();
            const compTypeIdx = ds.readVarInt();
            const rawTag = ds.readFourCC();
            const tag = DirectorFile.unprotect(rawTag);


            this.chunks.push({ 
                type: tag, 
                len: compSize, 
                uncompLen: uncompSize, 
                off: offset, 
                id: resId, 
                compType: compTypeIdx 
            });
        }
    }

    async _parseFgei() {
        this.ds.readFourCC();
        const ilsLogicalId = this.ds.readVarInt();
        this.ilsBodyOffset = this.ds.position;
        
        // Prioritize finding ILS chunk by tag 'ILS ' or resource ID 2 (typical)
        let ilsInfo = this.getChunksByType('ILS ')[0];
        if (!ilsInfo) ilsInfo = this.getChunkById(ilsLogicalId) || this.getChunkById(2);

        if (ilsInfo && ilsInfo.len > 0 && ilsInfo.len < this.ds.length) {
            await this.loadInlineStream(ilsInfo);
        } else {
            this.log('WARNING', `FGEI: Could not find valid ILS chunk. ilsLogicalId=${ilsLogicalId}`);
        }
    }

    async loadInlineStream(ilsInfo) {
        const decomp = await this.getChunkData(ilsInfo);
        if (!decomp) {
            this.log('ERROR', `loadInlineStream: Failed to decompress ILS chunk data.`);
            return;
        }
        
        const ds = new DataStream(decomp, this.ds.endianness);
        
        let loadedCount = 0;
        while (ds.position + 1 < ds.length) {
            const resId = ds.readVarInt();
            const chunk = this.getChunkById(resId);
            if (chunk) {
                chunk.isIlsResident = true;
                chunk.off = ds.position;
                
                if (ds.position + chunk.len <= ds.length) {
                    // this.cachedViews[resId] = ds.readBytes(chunk.len);
                    this.cachedViews[resId] = Buffer.from(ds.readBytes(chunk.len));
                    loadedCount++;
                } else {
                    this.log('WARNING', `loadInlineStream: Chunk ${resId} (${chunk.type}) overflows ILS buffer. len=${chunk.len} remaining=${ds.length - ds.position}`);
                    break;
                }
            } else {
                this.log('WARNING', `loadInlineStream: Unknown resource ID ${resId} in ILS at pos ${ds.position}. Stop.`);
                break; 
            }
        }
    }

    async getChunkData(chunk) {
        if (!chunk) return null;
        if (this.cachedViews[chunk.id]) return this.cachedViews[chunk.id];

        let raw = null;
        try {
            if (this.isAfterburned && chunk.isIlsResident && this._ilsBody) {
                if (chunk.off + chunk.len <= this._ilsBody.length) {
                    raw = this._ilsBody.slice(chunk.off, chunk.off + chunk.len);
                } else {
                    this.log('WARNING', `getChunkData: Chunk ${chunk.id} (${chunk.type}) out of ILS range. off=${chunk.off} len=${chunk.len} ils=${this._ilsBody.length}`);
                }
            } else if (this.ds) {
                const pos = this.isAfterburned ? (this.ilsBodyOffset + chunk.off) : (chunk.off + 8);
                if (pos >= 0 && pos < this.ds.length) {
                    this.ds.seek(pos);
                    raw = this.ds.readBytes(chunk.len);
                } else {
                    this.log('WARNING', `getChunkData: Pos out of range for chunk ${chunk.id}: ${pos}`);
                }
            }
        } catch (e) {
            this.log('ERROR', `getChunkData failed for chunk ${chunk.id} (${chunk.type}): ${e.message}`);
        }

        if (!raw || raw.length === 0) return null;

        let data = raw;
        const isZlib = raw.length > 2 && raw[0] === 0x78 && (raw[1] === 0x01 || raw[1] === 0x9c || raw[1] === 0xda);
        if (chunk.compType === 1 || (chunk.uncompLen > 0 && chunk.uncompLen !== chunk.len) || isZlib) {
            try {
                data = zlib.inflateSync(raw);
            } catch (e) {
                try {
                    data = zlib.inflateRawSync(raw);
                } catch (e2) {
                    this.log('ERROR', `Decompression failed for chunk ${chunk.id}: ${e2.message}`);
                    data = raw;
                }
            }
        }
        this.cachedViews[chunk.id] = data;
        return data;
    }

    static unprotect(tag) {
        if (!tag) return tag;
        return AfterburnerTags[tag] || tag;
    }
}

module.exports = DirectorFile;
