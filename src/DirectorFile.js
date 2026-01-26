/**
 * @version 1.1.5
 * DirectorFile.js - Core binary parser for Adobe Director project archives
 * 
 * This class handles the low-level parsing of RIFX (Mac), XFIR (Windows), 
 * and Afterburner/Shockwave (Compressed) file formats. It reconstructs 
 * the chunk-based structure and provides a virtualized interface for data extraction.
 */

const zlib = require('zlib');
const DataStream = require('./utils/DataStream');
const { Magic, AfterburnerTags, Limits } = require('./Constants');

class DirectorFile {
    /**
     * @param {Buffer} buffer - Raw file data
     * @param {Function} logger - Callback for standardized logging
     */
    constructor(buffer, logger) {
        this.ds = new DataStream(buffer);
        this.log = logger || ((lvl, msg) => console.log(`[DirectorFile][${lvl}] ${msg}`));
        this.chunks = [];
        this.cachedViews = {};
        this.isAfterburned = false;
        this.ilsBodyOffset = 0;
        this.format = 'unknown';
        this.fmap = null;
        this.subtype = null;
    }

    /**
     * Resolves a chunk index to a physical structure, handling Fmap redirections
     * used in compressed files.
     */
    getChunkById(id) {
        let physicalId = id;
        if (this.fmap && this.fmap[id] !== undefined) {
            physicalId = this.fmap[id];
        }
        return this.chunks.find(c => c.id === physicalId);
    }

    /**
     * Identifies file format and initializes appropriate parsing strategy.
     */
    async parse() {
        const magic = this.ds.readFourCC();

        if (magic === Magic.XFIR) {
            this.ds.endianness = 'little';
            this.format = 'rifx-little';
        } else if (magic === Magic.FGDC) {
            this.isAfterburned = true;
            this.format = 'afterburner';
        } else if (magic === Magic.RIFX) {
            this.format = 'rifx-big';
        } else {
            throw new Error(`Unsupported file format: ${magic}`);
        }

        if (this.isAfterburned) {
            await this.calculateAfterburnedStructure();
        } else {
            const fileSize = this.ds.readUint32();
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

    /**
     * Scans the Memory Map (mmap) for uncompressed asset chunks.
     */
    async parseUncompressedStructure() {
        let mmapOff = 0;
        this.ds.seek(0);
        this.ds.skip(12);

        while (this.ds.position + 12 < this.ds.buffer.length) {
            const tag = this.ds.readFourCC();
            const len = this.ds.readUint32();

            if (tag === Magic.IMAP) {
                this.ds.skip(4);
                mmapOff = (this.ds.endianness === 'little') ? this.ds.buffer.readUInt32LE(this.ds.position) : this.ds.buffer.readUInt32BE(this.ds.position);
                break;
            } else if (tag === Magic.MMAP) {
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
        const maxChunks = this.ds.readInt32(); // Added per Habbo alignment
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

    /**
     * Handles decompression of Afterburner catalog and asset mapping.
     */
    async calculateAfterburnedStructure() {
        // 1. File Version (Fver)
        if (DirectorFile.unprotectTag(this.ds.peekFourCC()) === AfterburnerTags.Fver) {
            this.ds.readFourCC();
            this.ds.skip(this.ds.readVarInt());
        }

        // 2. Logical Mapping (Fmap)
        if (DirectorFile.unprotectTag(this.ds.peekFourCC()) === AfterburnerTags.Fmap) {
            this.ds.readFourCC();
            const fmapEnd = this.ds.position + this.ds.readVarInt();
            this.fmap = {};
            while (this.ds.position < fmapEnd) {
                const logicalId = this.ds.readVarInt();
                const physicalId = this.ds.readVarInt();
                this.fmap[logicalId] = physicalId;
            }
        }

        // 3. File Catalog (Fcdr)
        if (DirectorFile.unprotectTag(this.ds.peekFourCC()) === AfterburnerTags.Fcdr) {
            this.ds.readFourCC();
            const fcdrLen = this.ds.readVarInt();
            const fcdrDecomp = zlib.inflateSync(this.ds.readBytes(fcdrLen));
            const fcdrDS = new DataStream(fcdrDecomp, this.ds.endianness);
            fcdrDS.skip(fcdrDS.readUint16() * 16);
        }

        // 4. Asset Allocation (Abmp)
        const tag = DirectorFile.unprotectTag(this.ds.peekFourCC());
        if ([AfterburnerTags.Abmp, 'ABMP', AfterburnerTags.PMBA].includes(tag)) {
            this.ds.readFourCC();
            const abmpLen = this.ds.readVarInt();
            const abmpEnd = this.ds.position + abmpLen;
            this.ds.readVarInt(); // skip uncompressed size
            this.ds.readVarInt(); // skip second header field
            const abmpDecomp = zlib.inflateSync(this.ds.readBytes(abmpEnd - this.ds.position));
            const abmpDS = new DataStream(abmpDecomp, this.ds.endianness);
            abmpDS.readVarInt(); // skip unk1
            abmpDS.readVarInt(); // skip unk2
            const resCount = abmpDS.readVarInt();
            this.mapAssets(abmpDS, resCount);
        }

        // 5. Inline Stream (FGEI)
        const nextTag = DirectorFile.unprotectTag(this.ds.peekFourCC());
        if ([AfterburnerTags.FGEI, AfterburnerTags.IEGF].includes(nextTag)) {
            this.ds.readFourCC();
            this.ds.readVarInt();
            this.ilsBodyOffset = this.ds.position;
            const ilsInfo = this.chunks.find(c => c.id === 2);
            if (ilsInfo) await this.loadInlineStream(ilsInfo);
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
            const chunkType = DirectorFile.unprotectTag(rawTag);

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
                const info = this.chunks.find(c => c.id === resId);
                if (info) {
                    if (info.len > 10000000) break; // Safety limit
                    this.cachedViews[resId] = ilsDS.readBytes(info.len);
                } else break;
            }
        } catch (e) {
            this.log('ERROR', `ILS recovery failed: ${e.message}`);
        }
    }

    /**
     * Retrieves chunk data, handling transparent decompression and caching.
     */
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
                    data = this._safeDecompress(raw);
                } else {
                    data = raw;
                }
            } else {
                this.ds.seek(chunk.off + 8);
                data = this.ds.readBytes(chunk.len);
            }
        } catch (e) {
            this.log('ERROR', `Chunk read error ${chunk.id} (${chunk.type}): ${e.message}`);
            return null;
        }

        if (data) this.cachedViews[chunk.id] = data;
        return data;
    }

    _safeDecompress(raw) {
        try {
            return zlib.inflateSync(raw);
        } catch (e) {
            try {
                if (raw.length > 4) return zlib.inflateSync(raw.slice(4));
            } catch (e2) {
                try {
                    return zlib.inflateRawSync(raw);
                } catch (e3) {
                    try {
                        if (raw.length > 4) return zlib.inflateRawSync(raw.slice(4));
                    } catch (e4) {
                        return raw;
                    }
                }
            }
        }
        return raw;
    }

    /**
     * Translates protected Afterburner tags back to their standard FourCC names.
     */
    static unprotectTag(tag) {
        const tagMap = {
            'pami': 'imap',   // Protected Initial Map
            'pamm': 'mmap',   // Protected Memory Map
            '*YEK': 'KEY*',   // Protected Key Table (byte-swapped)
            'YEK*': 'KEY*',   // Protected Key Table
            'Lscl': 'MCsL',   // Movie Cast Script List (protected)
            'XtcL': 'LctX',   // Lingo Script Text/Context (protected)
            'manL': 'Lnam',   // Lingo Name Table (protected)
            'rcsL': 'Lscr',   // Lingo Compiled Script (protected)
            'CAS*': 'CASt',   // Cast Member Data (protected)
            'snd ': 'SND ',    // Sound Data (protected/lowercase)
            'DIB ': 'BITD',    // Bitmap Data (Shockwave 32-bit)
            'DIB*': 'BITD',    // Bitmap Data (Shockwave 32-bit alternate)
            'ediM': 'medi',    // Media (Shockwave)
            'SND ': 'snd ',    // Sound (Shockwave)
            'muhT': 'Thum',    // Thumbnail (Shockwave)
            'STG ': 'Grid'     // Grid (Shockwave)
        };
        return tagMap[tag] || tag;
    }
}

module.exports = DirectorFile;
