/**
 * @version 1.3.6
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
        this.isLittleEndianFile = false;
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
        // Use findLast to ensure ABMP (parsed later) entries overwrite Fcdr/mmap entries
        const matches = this.chunks.filter(c => c.id === physicalId);
        return matches.length > 0 ? matches[matches.length - 1] : null;
    }

    async parse() {
        if (!this.ds) return;
        const magic = this.ds.readFourCC();
        const size = this.ds.readUint32();

        this.isLittleEndianFile = (magic === Magic.XFIR);

        if (this.isLittleEndianFile) {
            this.ds.endianness = 'little';
            this.format = 'rifx-little';
        } else {
            this.ds.endianness = 'big';
            this.format = 'rifx-big';
        }

        const internalMagic = this.ds.readFourCC();

        // Handle Afterburner variants:
        // FGDC (CCT), FGDM (DCR)
        // CDGF (byte-swapped FGDC), MDGF (byte-swapped FGDM)
        const isAfterburner = [Magic.FGDC, Magic.FGDM, 'CDGF', 'MDGF'].includes(magic) ||
            [Magic.FGDC, Magic.FGDM, 'CDGF', 'MDGF'].includes(internalMagic);

        if (isAfterburner) {
            this.isAfterburned = true;
            this.format = 'afterburner';
            await this.calculateAfterburnedStructure();
        } else if (magic === Magic.XFIR || magic === Magic.RIFX) {
            // Uncompressed RIFX
            await this.parseUncompressedStructure();
        } else {
            throw new Error(`Unsupported file format: ${magic}`);
        }
    }

    async parseUncompressedStructure() {
        let mmapOff = 0;
        this.ds.seek(12);
        this.subtype = this.ds.readFourCC();

        // Standard RIFX search for IMAP/MMAP
        this.ds.seek(12);
        while (this.ds.position + 12 < this.ds.buffer.length) {
            const tag = this.ds.readFourCC();
            const len = this.ds.readUint32();

            if (tag === Magic.IMAP || tag === Magic.imap || tag === 'pami') {
                this.ds.skip(4);
                mmapOff = (this.ds.endianness === 'little') ? this.ds.buffer.readUInt32LE(this.ds.position) : this.ds.buffer.readUInt32BE(this.ds.position);
                break;
            } else if (tag === Magic.MMAP || tag === Magic.mmap || tag === 'pamm') {
                mmapOff = this.ds.position - 8;
                break;
            }
            this.ds.skip(Math.max(0, len));
        }

        if (!mmapOff) {
            // Check for ILS directly (protected casts often have this)
            this.ds.seek(8);
            const tag = this.ds.readFourCC();
            if (tag === Magic.ILS || tag === 'ILS ' || tag === ' ,i') {
                await this._parseILS();
                return;
            }
            throw new Error(`Failed to locate Memory Map (mmap) in ${this.format} file.`);
        }

        this.ds.seek(mmapOff);
        this.ds.readFourCC(); // mmap / pamm
        this.ds.readUint32(); // len
        this.ds.skip(4);
        this.ds.readInt32(); // maxChunks
        const usedChunks = this.ds.readInt32();
        this.ds.skip(12);

        for (let i = 0; i < usedChunks; i++) {
            const tag = this.ds.readFourCC();
            const len = this.ds.readUint32();
            const off = this.ds.readUint32();

            let uncompLen = 0;
            let compType = 0;
            let flags = 0;
            let link = 0;

            if (this.isAfterburned) {
                uncompLen = this.ds.readUint32();
                compType = this.ds.readUint32();
            } else {
                flags = this.ds.readUint32();
                link = this.ds.readInt32();
            }

            if (off > 0) {
                console.log(`[DirectorFile] Pushing chunk: ${tag} (PID ${i}) at off ${off}`);
                this.chunks.push({
                    type: tag,
                    len,
                    off,
                    id: i,
                    uncompLen,
                    compType,
                    flags,
                    link
                });
            }
        }
    }

    async _parseILS() {
        const ds = this.ds;
        ds.seek(8);
        const magic = ds.readFourCC(); // ILS 
        const totalLen = ds.readUint32();
        const headerLen = ds.readUint32();
        const count = ds.readUint32();

        if (count > 0xFFFF) {
            // Misread count likely means endianness issue in ILS chunk
            this.log('WARNING', `Absurd ILS chunk count: ${count}. Retrying with swapped endianness.`);
            this.ds.endianness = this.ds.endianness === 'big' ? 'little' : 'big';
            ds.seek(8 + 4 + 4);
            // Re-read count
            const count2 = ds.readUint32();
            // If still absurd, we're stuck
        }

        for (let i = 0; i < count; i++) {
            const tag = ds.readFourCC();
            const len = ds.readUint32();
            const off = ds.readUint32();
            console.log(`[DirectorFile] ILS Pushing: ${tag} (PID ${i}) at off ${off}`);
            this.chunks.push({ type: tag, len, off, id: i });
        }
        this.log('INFO', `Loaded ILS with ${this.chunks.length} chunks.`);
    }

    async calculateAfterburnedStructure() {
        try {
            // FGDC structure: Fver, Fmap, Fcdr, Abmp, [Fgei + InlineStream]
            // We search for these sequentially
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
        if (this.isLittleEndianFile) return;

        // Heuristic: Check KEY* chunk for sanity
        const checkChunk = this.chunks.find(c => DirectorFile.unprotect(c.type) === 'KEY*');

        if (checkChunk) {
            const data = await this.getChunkData(checkChunk);
            if (data && data.length >= 12) {
                const oldEndian = this.ds.endianness;
                const ds = new DataStream(data, oldEndian);
                const firstWord = ds.readUint16();

                if (firstWord > 0xFF && (firstWord & 0xFF) === 0x01) {
                    // Looks like swapped 0x0114 or similar
                } else if (firstWord > 0x1000) {
                    this.ds.endianness = (oldEndian === 'big') ? 'little' : 'big';
                    this.log('INFO', `Auto-detected endianness mismatch in KEY*. Switched from ${oldEndian} to ${this.ds.endianness}.`);
                }
            }
        }
    }

    async _parseFver() {
        const tag = DirectorFile.unprotect(this.ds.peekFourCC());
        if (tag === Magic.FVER) {
            this.ds.readFourCC();
            this.ds.skip(this.ds.readVarInt());
        }
    }

    async _parseFmap() {
        const tag = DirectorFile.unprotect(this.ds.peekFourCC());
        if (tag === Magic.FMAP) {
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
        if (tag === Magic.FCDR) {
            this.ds.readFourCC();
            const fcdrLen = this.ds.readVarInt();
            const rawDecomp = zlib.inflateSync(this.ds.readBytes(fcdrLen));

            // In modern files, FCDR often contains a metadata string 
            // ("Macromedia ziplib compression...") instead of actual catalog entries.
            const headerStr = rawDecomp.slice(0, 128).toString('ascii');
            if (headerStr.includes('Macromedia')) {
                this.log('DEBUG', 'FCDR contains metadata string, skipping as catalog.');
                return;
            }

            const fcdrDS = new DataStream(rawDecomp, 'big');
            if (fcdrDS.buffer.length < 2) return;
            const entryCount = fcdrDS.readUint16();

            for (let i = 0; i < entryCount; i++) {
                if (fcdrDS.position + 16 > fcdrDS.buffer.length) break;
                const entryTag = fcdrDS.readFourCC();
                const len = fcdrDS.readUint32();
                const off = fcdrDS.readUint32();
                fcdrDS.readUint32(); // Unknown/Flags
                if (off > 0) {
                    this.chunks.push({ type: DirectorFile.unprotect(entryTag), len, off, id: i });
                }
            }
        }
    }

    async _parseAbmp() {
        const tag = DirectorFile.unprotect(this.ds.peekFourCC());
        if ([Magic.ABMP, Magic.PMBA].includes(tag) || tag.toUpperCase() === 'ABMP') {
            this.ds.readFourCC(); // Read the tag
            const abmpLen = this.ds.readVarInt();
            const abmpDataEnd = this.ds.position + abmpLen;
            this.ds.readVarInt(); // h1
            this.ds.readVarInt(); // h2

            const compressed = this.ds.readBytes(abmpDataEnd - this.ds.position);
            const decompressed = zlib.inflateSync(compressed);

            const abmpDS = new DataStream(decompressed, this.ds.endianness);
            abmpDS.readVarInt(); // v1
            abmpDS.readVarInt(); // v2
            const resCount = abmpDS.readVarInt();

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
                    compType: compTypeIdx,
                    flags: 0,
                    link: 0
                });
            }
        }
    }

    async _parseFgei() {
        const tag = DirectorFile.unprotect(this.ds.peekFourCC());
        if (tag === Magic.FGEI || tag === Magic.IEGF) {
            this.ds.readFourCC();
            const ilsIndex = this.ds.readVarInt();
            this.log('DEBUG', `FGEI points to ILS directory index: ${ilsIndex}`);
            this.ilsBodyOffset = this.ds.position;
            const ilsInfo = this.chunks[ilsIndex];
            if (ilsInfo) {
                await this.loadInlineStream(ilsInfo);
            } else {
                this.log('WARNING', `ILS directory chunk at index ${ilsIndex} not found.`);
            }
        }
    }

    async loadInlineStream(ilsInfo) {
        try {
            const decomp = await this.getChunkData(ilsInfo);
            if (!decomp) {
                this.log('WARNING', `Could not get data for ILS directory chunk ${ilsInfo.id}`);
                return;
            }
            const ilsDS = new DataStream(decomp, this.ds.endianness);
            while (ilsDS.position < ilsDS.buffer.length) {
                const resId = ilsDS.readVarInt();
                const chunkInfo = this.chunks.find(c => c.id === resId);
                if (chunkInfo) {
                    if (chunkInfo.len > Limits.InternalStreamSafetyLimit) {
                        this.log('WARNING', `Chunk ${resId} too large for ILS: ${chunkInfo.len}`);
                        break;
                    }
                    if (ilsDS.position + chunkInfo.len > ilsDS.buffer.length) {
                        this.log('WARNING', `ILS body overflow at resId ${resId}`);
                        break;
                    }
                    this.cachedViews[resId] = ilsDS.readBytes(chunkInfo.len);
                } else {
                    this.log('DEBUG', `Unknown resId ${resId} in ILS directory.`);
                    break;
                }
            }
            this.log('INFO', `Loaded ILS with ${Object.keys(this.cachedViews).length} chunks.`);
        } catch (e) {
            this.log('ERROR', `Failed to load Inline Stream: ${e.message}`);
        }
    }

    async getChunkData(chunk) {
        if (!chunk) return null;
        if (this.cachedViews[chunk.id]) return this.cachedViews[chunk.id];

        if (this.isAfterburned && (chunk.off === undefined || chunk.off === -1)) {
            return null;
        }

        if (chunk.off === undefined) return null;

        let data;
        try {
            this.ds.seek(this.isAfterburned ? (this.ilsBodyOffset + chunk.off) : (chunk.off + 8));
            const raw = this.ds.readBytes(chunk.len);

            if (chunk.compType === 1 || (chunk.uncompLen > 0 && chunk.uncompLen !== chunk.len)) {
                try {
                    data = zlib.inflateSync(raw);
                } catch (e) {
                    try {
                        data = zlib.inflateRawSync(raw);
                    } catch (e2) {
                        if (raw.length > 4) {
                            try { data = zlib.inflateRawSync(raw.slice(4)); } catch (e) { data = raw; }
                        } else {
                            data = raw;
                        }
                    }
                }
            } else {
                data = raw;
            }
        } catch (e) {
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
