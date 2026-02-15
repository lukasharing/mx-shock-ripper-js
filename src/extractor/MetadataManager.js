const crypto = require('crypto');
const DirectorFile = require('../DirectorFile');
const CastMember = require('../CastMember');
const DataStream = require('../utils/DataStream');
const { Magic, AfterburnerTags, MemberType, Offsets, KeyTableValues } = require('../Constants');

class MetadataManager {
    constructor(extractor) {
        this.extractor = extractor;
        this.keyTable = {};
        this.resToMember = {};
        this.nameTable = {};
        this.lctxMap = {};
        this.castList = []; // Implicit Slot Order from Key Table
    }

    async parseKeyTable() {
        const keyChunk = this.extractor.dirFile.chunks.find(c => {
            const unprot = DirectorFile.unprotect(c.type).toUpperCase();
            return unprot === 'KEY*' || unprot === 'KEY ';
        });
        if (!keyChunk) return;

        const data = await this.extractor.dirFile.getChunkData(keyChunk);

        if (!data || data.length < 12) return;

        const ds = new DataStream(data, this.extractor.dirFile.ds.endianness);
        let firstWord = ds.readUint16();

        // Auto-calibrate endianness based on version word 0x0114 (276)
        if (firstWord !== 0x0114 && firstWord !== 0x000C && firstWord !== 0x0002) {
            const swapped = (firstWord >> 8) | ((firstWord & 0xFF) << 8);
            if (swapped === 0x0114 || swapped === 0x000C || swapped === 0x0002) {
                ds.endianness = ds.endianness === 'big' ? 'little' : 'big';
                ds.seek(0);
                firstWord = ds.readUint16();
            }
        }

        let headerSize = (firstWord === 0x0114 || firstWord === 0x1401) ? Offsets.KeyTableStandard : Offsets.KeyTableShort;

        // Safety check: if buffer is too small for standard header, downgrade to short
        if (headerSize === Offsets.KeyTableStandard && data.length < Offsets.KeyTableStandard) {
            headerSize = Offsets.KeyTableShort;
        }

        let usedCount, totalCount;
        if (headerSize === Offsets.KeyTableShort) {
            ds.seek(4);
            totalCount = ds.readUint32();
            ds.seek(8);
            usedCount = ds.readUint32();
        } else {
            ds.seek(12);
            totalCount = ds.readUint32();
            ds.seek(16);
            usedCount = ds.readUint32();
        }

        // Determine entry size
        // D5+ entries are 12 bytes: sectionID(4), castID(4), tag(4)
        // D4 entries are 8 bytes: sectionID(4), tag(4). castID is implied as index (1-based)
        const remainingSize = data.length - headerSize;
        const entrySize = totalCount > 0 ? Math.floor(remainingSize / totalCount) : 12;

        this.extractor.log('DEBUG', `[Metadata] KEY* info: usedCount=${usedCount}, totalCount=${totalCount}, entrySize=${entrySize}, headerSize=${headerSize}`);

        ds.seek(headerSize);
        for (let i = 0; i < usedCount; i++) {
            if (ds.position + entrySize > data.length) break;

            let sectionID, castID, tag;

            if (entrySize === Offsets.KeyEntryStandard) {
                sectionID = ds.readInt32();
                castID = ds.readInt32();
                tag = ds.readFourCC();
            } else if (entrySize === Offsets.KeyEntryShort) {
                sectionID = ds.readInt32();
                tag = ds.readFourCC();
                castID = i + 1; // Implied index
            } else {
                ds.skip(entrySize);
                continue;
            }

            this.extractor.log('DEBUG', `[Metadata] KEY* entry ${i + 1}: tag=${tag}, castID=${castID}, sectionID=${sectionID}`);
            if (!this.keyTable[castID]) this.keyTable[castID] = {};
            this.keyTable[castID][tag] = sectionID;
            this.resToMember[sectionID] = castID;

            // Capture Cast Sort Order (Implicit Slot ID)
            // Slot indices are 1-based (i+1)
            this.castList[i + 1] = castID;

            // Populate ILS (Initial Load Segment) mapping from KEY* table
            this.lctxMap[i + 1] = sectionID;
        }

        const lctxChunks = this.extractor.dirFile.chunks.filter(c => {
            const rawType = c.type;
            const unprot = DirectorFile.unprotect(rawType).toUpperCase().trim();
            if (unprot.includes('LCTX') || unprot.includes('XTCL')) return true;
            return false;
        });
        for (const chunk of lctxChunks) {
            const data = await this.extractor.dirFile.getChunkData(chunk);
            if (!data) {
                this.extractor.log('WARNING', `Failed to get data for LCTX chunk ${chunk.id}`);
                continue;
            }
            if (data.length < 18) {
                this.extractor.log('WARNING', `LCTX chunk ${chunk.id} too small: ${data.length}`);
                continue;
            }

            try {
                const ds = new DataStream(data, this.extractor.dirFile.ds.endianness);
                ds.skip(8);
                let entryCount = ds.readUint32();

                // Auto-calibrate LCTX endianness
                if (entryCount > 0xFFFF) {
                    ds.endianness = ds.endianness === 'big' ? 'little' : 'big';
                    ds.seek(8);
                    entryCount = ds.readUint32();
                }

                this.extractor.log('INFO', `Parsing LCTX chunk ${chunk.id} with ${entryCount} entries. Endianness: ${ds.endianness}`);

                ds.readUint32();
                const entriesOffset = ds.readUint16();

                if (entriesOffset < data.length) {
                    ds.seek(entriesOffset);
                    for (let i = 1; i <= entryCount; i++) {
                        if (ds.position + 12 > data.length) break;
                        ds.readInt32();
                        const sectionId = ds.readInt32();
                        ds.readUint16();
                        ds.readUint16();

                        if (sectionId > -1) {
                            const chunk = this.extractor.dirFile.chunks.find(c => c.id === sectionId);
                            const chunkType = chunk ? DirectorFile.unprotect(chunk.type) : 'unknown';
                            this.extractor.log('INFO', `[Metadata] LCTX Map: logicalID=${i} -> physicalID=${sectionId} (Type: ${chunkType})`);
                            this.lctxMap[i] = sectionId;
                        }
                    }
                }
            } catch (e) {
                this.extractor.log('ERROR', `Failed to parse LCTX chunk ${chunk.id}: ${e.message}`);
            }
        }
    }

    async parseMCsL() {
        // Priority 1: Generic MCsL/abmc tag
        let mcslChunk = this.extractor.dirFile.chunks.find(c => {
            const unprot = DirectorFile.unprotect(c.type);
            return unprot === 'MCsL' || unprot === 'abmc';
        });

        let foundViaTag = null;
        // Priority 2: CAS* tag from KEY* table (Authoritative for Afterburner)
        if (!mcslChunk) {
            for (const castId in this.keyTable) {
                const map = this.keyTable[castId];
                if (map['CAS*'] || map['cas*']) {
                    const sectionId = map['CAS*'] || map['cas*'];
                    mcslChunk = this.extractor.dirFile.getChunkById(sectionId);
                    if (mcslChunk) {
                        foundViaTag = 'CAS*';
                        break;
                    }
                }
            }
        }

        if (!mcslChunk) return;

        try {
            const data = await this.extractor.dirFile.getChunkData(mcslChunk);
            if (!data) return;

            // Force Big Endian for Sort Order physical IDs
            const ds = new DataStream(data, 'big');

            // Determine element size. 
            // Standard MCsL is 16-bit. 
            // Afterburner CAS* is often 32-bit physical IDs.
            const unprotType = DirectorFile.unprotect(mcslChunk.type);
            const use32 = (foundViaTag === 'CAS*' || unprotType === 'CAS*' || unprotType === 'cas*') && (data.length % 4 === 0);

            this.extractor.log('INFO', `Parsing Cast Order (${foundViaTag || unprotType}, Chunk ${mcslChunk.id}) as flat array. Element size: ${use32 ? 32 : 16}-bit`);

            this.extractor.castOrder = [];
            let slotIndex = 1;
            while (ds.position + (use32 ? 4 : 2) <= data.length) {
                const sectionId = use32 ? ds.readUint32() : ds.readUint16();
                if (sectionId === 0) {
                    slotIndex++;
                    continue;
                }
                // Map physical ID (sectionId) to castID
                const memberId = this.resToMember[sectionId] || sectionId;
                this.extractor.castOrder[slotIndex] = memberId;
                slotIndex++;
            }

            this.extractor.log('INFO', `[Metadata] Loaded ${slotIndex - 1} slots from Cast Order.`);

        } catch (e) {
            this.extractor.log('ERROR', `Failed to parse MCsL: ${e.message}`);
        }
    }

    async parseNameTable() {
        const lnam = this.extractor.dirFile.chunks.find(c => c.type === Magic.LNAM || c.type === AfterburnerTags.manL);
        if (lnam) {
            const data = await this.extractor.dirFile.getChunkData(lnam);
            if (data) this.nameTable = this.extractor.lnamParser.parse(data, 'big');
        }
    }

    /**
     * Resolves a palette cast slot number to its actual section ID.
     * @param {number} castSlot - The cast slot number from paletteId
     * @returns {number|null} - The section ID of the palette, or null if not found
     */
    resolvePaletteId(paletteId) {
        if (paletteId === 0) return null;

        let targetId = null;
        let source = 'none';

        // Director Palette Resolution Logic:
        // Member logical IDs start at minMember (typically 1 or 4 in Habbo).
        // paletteId in BITD/CASt refers to a logical member index.
        // Formula: SlotIndex = paletteId - minMember + 1
        // This accounts for the "3-slot shift" in US/BR/ES variants (minMember=4)
        // vs direct mapping in UK variants (minMember=1).
        const minMember = (this.movieConfig && this.movieConfig.minMember !== undefined) ? this.movieConfig.minMember : 1;
        const slotIndex = paletteId - minMember + 1;

        // 1. Try Cast Order Map (MCsL / CAS*) - Primary for slot-based paletteId
        if (slotIndex >= 0 && slotIndex < this.extractor.castOrder.length) {
            const memberId = this.extractor.castOrder[slotIndex];
            const map = this.keyTable[memberId];

            const isPalette = map && (map['CLUT'] || map['clut'] || map['Palt'] || map['palt']);
            if (isPalette) {
                targetId = memberId;
                source = `CastOrder(Slot ${slotIndex}, ID ${memberId})`;
            }
        }

        // 2. Try LctX map (logical index match) - Fallback ILS lookup
        if (!targetId && this.lctxMap[paletteId]) {
            const sectionId = this.lctxMap[paletteId];
            const memberId = this.resToMember[sectionId] || sectionId;
            const map = this.keyTable[memberId];

            const isPalette = map && (map['CLUT'] || map['clut'] || map['Palt'] || map['palt']);
            if (isPalette) {
                targetId = memberId;
                source = 'ILS/LCTX (CLUT)';
            }
        }

        // 3. Try keyTable (cast ID match) - Direct link
        if (!targetId && this.keyTable[paletteId]) {
            const sectionID = this.keyTable[paletteId]['CLUT'] ||
                this.keyTable[paletteId]['clut'] ||
                this.keyTable[paletteId]['Palt'] ||
                this.keyTable[paletteId]['palt'];
            if (sectionID) {
                targetId = paletteId;
                source = 'KeyTable';
            }
        }

        if (targetId) {
            this.extractor.log('DEBUG', `[Metadata] Resolved palette ${paletteId} to member ${targetId} via ${source}`);
        }

        return targetId;
    }


    async parseMemberMetadata(chunk, existingMember = null) {
        const type = DirectorFile.unprotect(chunk.type);
        const data = await this.extractor.dirFile.getChunkData(chunk);
        if (!data) return null;

        const memberIdFromRes = this.resToMember[chunk.id] || chunk.id;
        const member = CastMember.fromChunk(memberIdFromRes, data, this.extractor.dirFile.ds.endianness);

        // Attempt to capture legacy internal ID (Slot ID) from CASt header
        if (data.length >= Offsets.Cast.HeaderSize + 4) {
            const ds = new DataStream(data, 'big');
            ds.seek(Offsets.Cast.SlotId);
            member.originalSlotId = ds.readUint32();
        }

        // Resolve Descriptive Name from LNAM Pool
        // Hierarchy:
        // 1. Explicit nameIdx from CASt chunk (preferred for modern Director)
        // 2. Slot Index mapping (Director 4+ legacy fallback)
        // 3. Resource ID table lookup
        if (this.nameTable && this.nameTable.length > 0) {
            // Priority 1: Explicit nameIdx from CASt chunk (preferred for modern Director)
            if (member.nameIdx !== undefined && member.nameIdx > 0 && this.nameTable[member.nameIdx - 1]) {
                member.name = this.nameTable[member.nameIdx - 1];
            }
        }

        // Final Default: Generic member_ID
        if (!member.name) member.name = `member_${memberIdFromRes}`;
        member.name = member.name.trim();

        const hash = crypto.createHash('sha256');
        hash.update(data);
        hash.update(member.name);
        hash.update(CastMember.getTypeName(member.typeId));
        member.checksum = hash.digest('hex');

        const typeName = CastMember.getTypeName(member.typeId);
        this.extractor.stats.total++;
        this.extractor.stats.byType[typeName] = (this.extractor.stats.byType[typeName] || 0) + 1;

        // Primary lookup: try to find an existing member by the reliable resource-mapped ID first.
        // Fallback to originalSlotId only if absolutely necessary and valid (> 0).
        const targetMember = existingMember ||
            this.extractor.members.find(m => m.id === member.id) ||
            (member.originalSlotId > 0 ? this.extractor.members.find(m => m.id === member.originalSlotId) : null);

        if (targetMember) {
            // TODO: i should investigate here further
            // Safely merge properties from the newly parsed member into the existing instance
            targetMember.mergeProperties(member);
            return targetMember;
        }

        return member;
    }
    async parseDRCF() {
        const drcf = this.extractor.dirFile.chunks.find(c => {
            const unprot = DirectorFile.unprotect(c.type);
            return unprot === 'DRCF' || unprot === 'VWCF' || unprot === 'fgrD';
        });
        if (!drcf) return;

        const data = await this.extractor.dirFile.getChunkData(drcf);
        if (!data || data.length < 32) return;

        try {
            const ds = new DataStream(data, 'big');
            const len = ds.readInt16();

            // Offset 12 (int16): minMember - The base logical ID for the first member.
            // Offset 14 (int16): maxMember - The highest logical ID in the cast.
            ds.seek(12);
            const minMember = ds.readInt16();
            const maxMember = ds.readInt16();

            // Offset 30 (int16): defaultPalette.member - Used for standard movies.
            // ScummVM logic: If ID <= 0, it refers to a built-in platform palette.
            ds.seek(30);
            let paletteId = ds.readInt16();

            if (paletteId <= 0) {
                paletteId -= 1;
            }

            this.extractor.log('INFO', `Movie Config (DRCF): minMember=${minMember}, maxMember=${maxMember}, defaultPaletteId=${paletteId}`);
            this.movieConfig = {
                minMember,
                maxMember,
                defaultPaletteId: paletteId
            };
        } catch (e) {
            this.extractor.log('ERROR', `Failed to parse DRCF: ${e.message}`);
        }
    }

}

module.exports = MetadataManager;
