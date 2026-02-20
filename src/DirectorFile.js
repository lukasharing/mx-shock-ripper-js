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
        // Use findLast to ensure ABMP (parsed later) entries overwrite Fcdr/mmap entries
        const matches = this.chunks.filter(c => c.id === physicalId);
        return matches.length > 0 ? matches[matches.length - 1] : null;
    }

    async parse() {
        /**
         * Director Phase 1: Structural Discovery
         * We support both standard RIFX (MMAP) and compressed Afterburner formats.
         * For Afterburned files, standard catalogs are often encrypted or hidden,
         * requiring a robust multi-pass search across potential catalog chunks.
         */
        this.log('DEBUG', `DirectorFile.parse: Starting parsing (Size: ${this.fileSize})`);
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
        this.isAfterburned = [Magic.FGDC, Magic.FGDM, Magic.CDGF, Magic.MDGF].includes(magic) ||
            [Magic.FGDC, Magic.FGDM, Magic.CDGF, Magic.MDGF].includes(internalMagic);

        if (magic === Magic.XFIR || magic === Magic.RIFX) {
            // Standard RIFX container (might contain Afterburner internal stream)
            await this.parseUncompressedStructure();
            // Afterburned files require holistic structure calculation
            // to find potentially fragmented or out-of-order catalogs (ABMP, FCDR, ILS).
            await this.calculateAfterburnedStructure();
        } else if (this.isAfterburned) {
            // Direct Afterburner file (no RIFX wrapper, unusual but possible)
            this.format = 'afterburner';
            await this.calculateAfterburnedStructure();
        } else {
            throw new Error(`Unsupported file format: ${magic}`);
        }

        this._reindexChunks();
    }

    _reindexChunks() {
        this.chunkIndex = {};
        for (const c of this.chunks) {
            const type = DirectorFile.unprotect(c.type).toUpperCase().trim();
            if (!this.chunkIndex[type]) this.chunkIndex[type] = [];
            this.chunkIndex[type].push(c);
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

        // Standard RIFX search for IMAP/MMAP
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
            // Some protected casts have ILS but no standard mmap at the end.
            // Check if we already found chunks in ILS; if not, and it's not Afterburned, then it's a failure.
            if (this.chunks.length > 0 || this.isAfterburned) return;
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

            // Do not skip chunks with off=0. In RIFX/Afterburner, these are often placeholders 
            // that get resolved later (e.g. by ABMP), and we need them to maintain correct indexing.
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

    _parseILS() {
        const ds = this.ds;
        ds.seek(8);
        const magic = ds.readFourCC(); // ILS 
        const totalLen = ds.readUint32();
        const headerLen = ds.readUint32();
        let count = ds.readUint32();

        if (count > 0xFFFF) {
            // Misread count likely means endianness issue in ILS chunk
            this.log('WARNING', `Absurd ILS chunk count: ${count}. Retrying with swapped endianness.`);
            this.ds.endianness = this.ds.endianness === 'big' ? 'little' : 'big';
            ds.seek(8 + 4 + 4);
            const count2 = ds.readUint32();
            if (count2 > 0xFFFF) {
                this.log('ERROR', `ILS chunk count unrecoverable: ${count2}. Skipping ILS.`);
                return;
            }
            count = count2;
        }

        for (let i = 0; i < count; i++) {
            const tag = ds.readFourCC();
            const len = ds.readUint32();
            const off = ds.readUint32();
            this.chunks.push({ type: tag, len, off, id: i });
        }
    }

    /**
     * Holistic Afterburner Structure Discovery
     * ----------------------------------------
     * Standard Shockwave parsers often fail on modern Director files because
     * they expect catalogs to be sequential. We use an exhaustive search
     * for Afterburner-specific tags (ABMP, FCDR, ILS, PMBA, FGDC, etc.)
     * and handle recursive container chunks (CDGF) used in large files.
     */
    async calculateAfterburnedStructure() {
        try {
            // Seek past the RIFX/FGDC header
            this.ds.seek(12);

            // Robust search for FGDC sub-chunks: Fver, Fmap, Fcdr, Abmp, Fgei
            while (this.ds.position + 8 < this.ds.length) {
                const tag = DirectorFile.unprotect(this.ds.peekFourCC());
                if (tag === Magic.FVER) await this._parseFver();
                else if (tag === Magic.FMAP) await this._parseFmap();
                else if (tag === Magic.FCDR) await this._parseFcdr();
                else if ([Magic.ABMP, Magic.PMBA].includes(tag) || tag.toUpperCase() === Magic.ABMP.toUpperCase()) await this._parseAbmp();
                else if (tag === Magic.ILS || tag === Magic.ILS_REV) {
                    this._parseILS();
                } else if (tag === Magic.FGEI || tag === Magic.IEGF) {
                    await this._parseFgei();
                    break; // FGEI is followed by the Inline Stream (binary data), stop searching tags
                } else if ([Magic.FGDC, Magic.FGDM, Magic.CDGF, Magic.MDGF].includes(tag)) {
                    // Enter Afterburner container chunk
                    this.ds.readFourCC(); // Skip tag
                    this.ds.readUint32(); // Skip size (standard RIFX chunk size)
                    // Continue loop inside the chunk
                } else {
                    // Skip unknown tag (some files have stray padding or metadata chunks)
                    this.ds.skip(4);
                    const len = this.ds.readVarInt();
                    this.ds.skip(len);
                }
            }

            await this._autoDetectEndianness();
        } catch (e) {
            this.log('ERROR', `Failed to calculate afterburned structure: ${e.message}`);
            throw e;
        }
    }

    async _autoDetectEndianness() {
        if (this.isLittleEndianFile) return;

        // Heuristic: Check KEY* chunk for sanity
        const checkChunk = this.chunks.find(c => DirectorFile.unprotect(c.type) === Magic.KEY);

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
            if (fcdrDS.length < 2) return;
            const entryCount = fcdrDS.readUint16();

            for (let i = 0; i < entryCount; i++) {
                if (fcdrDS.position + 16 > fcdrDS.buffer.length) break;
                const entryTag = fcdrDS.readFourCC();
                const len = fcdrDS.readUint32();
                const off = fcdrDS.readUint32();
                fcdrDS.readUint32(); // Unknown/Flags
                // Do not skip entries with off=0; they are part of the catalog indexing.
                this.chunks.push({ type: DirectorFile.unprotect(entryTag), len, off, id: i });
            }
        }
    }

    async _parseAbmp() {
        const tag = DirectorFile.unprotect(this.ds.peekFourCC());
        if ([Magic.ABMP, Magic.PMBA].includes(tag) || tag.toUpperCase() === Magic.ABMP.toUpperCase()) {
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
            while (ilsDS.position < ilsDS.length) {
                const resId = ilsDS.readVarInt();
                const chunkInfo = this.chunks.find(c => c.id === resId);
                if (chunkInfo) {
                    if (chunkInfo.len > Limits.InternalStreamSafetyLimit) {
                        this.log('WARNING', `Chunk ${resId} too large for ILS: ${chunkInfo.len}`);
                        break;
                    }
                    if (ilsDS.position + chunkInfo.len > ilsDS.length) {
                        this.log('WARNING', `ILS body overflow at resId ${resId}`);
                        break;
                    }
                    this.cachedViews[resId] = ilsDS.readBytes(chunkInfo.len);
                } else {
                    break;
                }
            }
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
                        // Fallback: If both fail, try scanning for Zlib header (0x78)
                        for (let i = 0; i < Math.min(raw.length, 128); i++) {
                            if (raw[i] === 0x78 && (raw[i + 1] === 0x01 || raw[i + 1] === 0x9C || raw[i + 1] === 0xDA)) {
                                try {
                                    data = zlib.inflateSync(raw.slice(i));
                                    break;
                                } catch (inner) { }
                            }
                        }
                        if (!data) data = raw;
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
