/**
 * @version 1.4.2
 */
const crypto = require('crypto');
const DirectorFile = require('../DirectorFile');
const CastMember = require('../CastMember');
const DataStream = require('../utils/DataStream');
const KeyTableParser = require('../utils/KeyTableParser');
const { Palette } = require('../utils/Palette');
const { Magic, AfterburnerTags, Offsets, Limits } = require('../Constants');

class MetadataManager {
    constructor(extractor) {
        this.extractor = extractor;
        this.keyTable = {};
        this.resToMember = {};
        this.nameTables = []; // Array of { index: number, names: string[] }
        this.scriptToLnam = {};
        this.lctxMap = {};
        this.scriptContexts = [];
        this.scriptSlotMap = {};
        this.scriptSectionMap = {};
        this.castList = []; // Implicit Slot Order from Key Table
    }

    /**
     * Calculates a global hash for the cast library based on member count and key table entries.
     * Used for incremental extraction to detect if a cast lib has likely changed.
     */
    calculateCastHash() {
        const hash = crypto.createHash('sha256');
        const keys = Object.keys(this.keyTable).sort((a, b) => a - b);
        for (const castId of keys) {
            const map = this.keyTable[castId];
            const tags = Object.keys(map).sort();
            hash.update(`${castId}:`);
            for (const tag of tags) {
                hash.update(`${tag}=${map[tag]},`);
            }
        }
        // Also hash name tables if available
        if (this.nameTables && this.nameTables.length > 0) {
            for (const nt of this.nameTables) {
                hash.update(nt.names.join('|'));
            }
        }
        return hash.digest('hex');
    }

    ensureInvFmap() {
        if (this.invFmap || !this.extractor.dirFile.fmap) return;
        this.invFmap = {};
        for (const [logical, physical] of Object.entries(this.extractor.dirFile.fmap)) {
            this.invFmap[physical] = parseInt(logical, 10);
        }
    }

    _getScriptSectionFromMap(map) {
        if (!map) return 0;
        return map[Magic.LSCR] || map[Magic.LSCR_UPPER] || map[Magic.Lscl] || map[Magic.rcsL] || 0;
    }

    _getCastMetadataSectionFromMap(map) {
        if (!map) return 0;
        return map[Magic.CAST] || map[Magic.CAS_STAR] || map[Magic.CArT] || map[Magic.CAsT] || map[Magic.cast_lower] || 0;
    }

    _getChunkIndexById(id) {
        if (!Number.isInteger(id) || id <= 0 || !this.extractor?.dirFile?.chunks) return -1;
        return this.extractor.dirFile.chunks.findIndex(chunk => chunk.id === id);
    }

    getScriptContextsForSlot(slotId) {
        if (!Number.isInteger(slotId) || slotId <= 0) return [];
        return this.scriptSlotMap[slotId] || [];
    }

    hasScriptContextReference(id) {
        if (!Number.isInteger(id) || id <= 0) return false;
        return !!((this.scriptSlotMap[id] && this.scriptSlotMap[id].length > 0) ||
            (this.scriptSectionMap[id] && this.scriptSectionMap[id].length > 0));
    }

    _scoreScriptContext(member, ref) {
        let score = 0;

        if (!member || !ref) return score;

        const directScriptSection = this._getScriptSectionFromMap(this.keyTable[member.id]);
        if (directScriptSection > 0 && directScriptSection === ref.sectionId) score += 1000;

        if (this.resToMember[ref.sectionId] === member.id) score += 400;
        if (Number.isInteger(ref.ownerId) && ref.ownerId > 0) {
            if (ref.ownerId === member.id) score += 250;
            if (member.originalSlotId > 0 && ref.ownerId === member.originalSlotId) score += 225;
        }

        if (Number.isInteger(member._chunkIndex) && member._chunkIndex >= 0) {
            let ownerChunkIndex = -1;
            const ownerMap = ref.ownerId > 0 ? this.keyTable[ref.ownerId] : null;
            const ownerCastChunkId = this._getCastMetadataSectionFromMap(ownerMap);
            if (ownerCastChunkId > 0) ownerChunkIndex = this._getChunkIndexById(ownerCastChunkId);
            if (ownerChunkIndex < 0) ownerChunkIndex = this._getChunkIndexById(ref.chunkId);
            if (ownerChunkIndex >= 0) {
                const distance = Math.abs(member._chunkIndex - ownerChunkIndex);
                score += Math.max(0, 40 - Math.min(distance, 40));
                if (ownerChunkIndex <= member._chunkIndex) score += 5;
            }
        }

        return score;
    }

    getScriptContextCandidatesForMember(member, slotId = 0) {
        const targetSlotId = slotId > 0 ? slotId : (member?.scriptId || 0);
        if (!Number.isInteger(targetSlotId) || targetSlotId <= 0) return [];

        return this.getScriptContextsForSlot(targetSlotId)
            .map(ref => ({ ...ref, score: this._scoreScriptContext(member, ref) }))
            .sort((a, b) => {
                if (b.score !== a.score) return b.score - a.score;
                if ((a.ownerId || 0) !== (b.ownerId || 0)) return (a.ownerId || 0) - (b.ownerId || 0);
                return a.sectionId - b.sectionId;
            });
    }

    resolveScriptSectionId(member, { allowUniqueFallback = true } = {}) {
        if (!member) return null;

        const scriptSlotId = member.scriptId > 0
            ? member.scriptId
            : (this.hasScriptContextReference(member.id) ? member.id : 0);

        if (scriptSlotId > 0) {
            const candidates = this.getScriptContextCandidatesForMember(member, scriptSlotId);
            if (candidates.length === 1) return candidates[0].sectionId;
            if (candidates.length > 1 && candidates[0].score > candidates[1].score) return candidates[0].sectionId;
            if (allowUniqueFallback && this.lctxMap[scriptSlotId]) return this.lctxMap[scriptSlotId];
        }

        const directScriptSection = this._getScriptSectionFromMap(this.keyTable[member.id]);
        if (directScriptSection > 0) return directScriptSection;

        if (Number.isInteger(member._chunkIndex) && member._chunkIndex >= 0) {
            const directChunk = this.extractor.dirFile.chunks[member._chunkIndex];
            if (directChunk && [Magic.LSCR, Magic.LSCR_UPPER, Magic.Lscl, Magic.rcsL].includes(directChunk.type)) {
                return directChunk.id;
            }
        }

        return null;
    }

    resolveMemberIdFromResource(resourceId, { allowSelf = true } = {}) {
        if (!Number.isInteger(resourceId) || resourceId <= 0) return null;

        this.ensureInvFmap();
        const logicalId = (this.invFmap && this.invFmap[resourceId] !== undefined) ? this.invFmap[resourceId] : resourceId;
        const candidates = [];
        const pushCandidate = (value) => {
            if (!Number.isInteger(value) || value <= 0 || value >= Limits.MaxCastSlots) return;
            if (!candidates.includes(value)) candidates.push(value);
        };

        pushCandidate(this.resToMember[logicalId]);
        pushCandidate(this.resToMember[resourceId]);

        const members = Array.isArray(this.extractor.members) ? this.extractor.members : [];
        const linkedMember = members.find(member => member && (
            member.originalSlotId === logicalId ||
            member.originalSlotId === resourceId
        ));
        if (linkedMember) pushCandidate(linkedMember.id);

        for (const member of members) {
            const map = this.keyTable[member.id];
            if (!map) continue;
            if (Object.values(map).some(value => value === logicalId || value === resourceId)) {
                pushCandidate(member.id);
                break;
            }
        }

        if (this.extractor.castOrder) {
            pushCandidate(this.extractor.castOrder[logicalId]);
            pushCandidate(this.extractor.castOrder[resourceId]);
        }

        if (this.castList) {
            pushCandidate(this.castList[logicalId]);
            pushCandidate(this.castList[resourceId]);
        }

        const scriptRefs = [
            ...(this.scriptSectionMap[logicalId] || []),
            ...(this.scriptSectionMap[resourceId] || [])
        ];
        for (const ref of scriptRefs) {
            const numericScriptId = ref.slotId;
            const memberByScriptId = members.find(member => member && (member.scriptId === numericScriptId || member.id === numericScriptId));
            if (memberByScriptId) pushCandidate(memberByScriptId.id);
            pushCandidate(numericScriptId);
            if (ref.ownerId) pushCandidate(ref.ownerId);
        }

        if (allowSelf) {
            pushCandidate(logicalId);
            pushCandidate(resourceId);
        }

        return candidates[0] || null;
    }

    logKeyTableSummary(layout, entries) {
        const tagCounts = {};
        for (const entry of entries) {
            if (!entry.tag) continue;
            tagCounts[entry.tag] = (tagCounts[entry.tag] || 0) + 1;
        }

        const tagSummary = Object.entries(tagCounts)
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([tag, count]) => `${tag}:${count}`)
            .join(', ');

        this.extractor.log(
            'INFO',
            `[MetadataManager] Parsed KEY*: variant=${layout.variant}, entrySize=${layout.entrySize}, used=${entries.length}/${layout.usedCount}, members=${Object.keys(this.keyTable).length}${tagSummary ? `, tags={${tagSummary}}` : ''}`
        );
    }

    async parseKeyTable() {
        const keyChunks = this.extractor.dirFile.getChunksByType(Magic.KEY).concat(this.extractor.dirFile.getChunksByType('KEY '));
        const keyChunk = keyChunks[0];
        if (!keyChunk) return;

        const data = await this.extractor.dirFile.getChunkData(keyChunk);

        if (!data || data.length < 12) return;

        this.keyTable = {};
        this.resToMember = {};
        this.castList = [];
        this.scriptToLnam = {};
        this.lctxMap = {};
        this.scriptContexts = [];
        this.scriptSlotMap = {};
        this.scriptSectionMap = {};

        const parsed = KeyTableParser.parse(data, this.extractor.dirFile.ds.endianness, (lvl, msg) => this.extractor.log(lvl, msg));
        if (!parsed) return;

        const { layout, entries } = parsed;
        for (const entry of entries) {
            const { sectionID, castID, tag, index } = entry;
            if (!tag) {
                this.extractor.log('WARNING', `KEY* entry ${index} is missing a tag and was ignored.`);
                continue;
            }

            if (!this.keyTable[castID]) this.keyTable[castID] = {};
            this.keyTable[castID][tag] = sectionID;
            this.resToMember[sectionID] = castID;
            this.castList[index + 1] = castID;
        }

        this.logKeyTableSummary(layout, entries);

        const allLctx = this.extractor.dirFile.getChunksByType(Magic.LCTX_UPPER)
            .concat(this.extractor.dirFile.getChunksByType(Magic.Lctx))
            .concat(this.extractor.dirFile.getChunksByType(Magic.lctx_lower))
            .concat(this.extractor.dirFile.getChunksByType(Magic.XTCL));
        
        // Deduplicate chunks by ID
        const lctxChunks = [];
        const seenIds = new Set();
        for (const c of allLctx) {
            if (!seenIds.has(c.id)) {
                seenIds.add(c.id);
                lctxChunks.push(c);
            }
        }

        const contextOwnerBySection = {};
        for (const [ownerId, map] of Object.entries(this.keyTable)) {
            const sectionId = map[Magic.LCTX_UPPER] || map[Magic.LctX] || map[Magic.Lctx] || map[Magic.lctx_lower] || map[Magic.XTCL];
            if (sectionId > 0) contextOwnerBySection[sectionId] = parseInt(ownerId, 10);
        }

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
                let entryCount2 = ds.readUint32();
                let entriesOffset = ds.readUint16();
                let entrySize = ds.readUint16();

                // Auto-calibrate LCTX endianness
                // Endianness calibration fails if entryCount === 0 unless we check geometry offsets
                if (entryCount > 0xFFFF || entriesOffset > data.length || entrySize > 1024) {
                    ds.endianness = ds.endianness === 'big' ? 'little' : 'big';
                    ds.seek(8);
                    entryCount = ds.readUint32();
                    entryCount2 = ds.readUint32();
                    entriesOffset = ds.readUint16();
                    entrySize = ds.readUint16();
                }

                // D11/D12 LctX contains lnamSectionID at offset 32
                let lnamSectionId = -1;
                if (data.length >= 36) {
                    ds.seek(32);
                    lnamSectionId = ds.readInt32();
                }

                const ownerId = contextOwnerBySection[chunk.id] || this.resToMember[chunk.id] || null;
                const context = {
                    ownerId,
                    chunkId: chunk.id,
                    lnamSectionId,
                    slotToSection: {},
                    sectionToSlot: {}
                };

                if (entriesOffset < data.length) {
                    ds.seek(entriesOffset);
                    for (let i = 1; i <= entryCount; i++) {
                        const entryStart = ds.position;
                        if (entryStart + entrySize > data.length) break;

                        ds.readInt32(); // unknown/flags
                        const sectionId = ds.readInt32();

                        // Advance to next entry based on actual size, rather than sequential fixed reads
                        ds.seek(entryStart + entrySize);

                        if (sectionId > -1) {
                            context.slotToSection[i] = sectionId;
                            context.sectionToSlot[sectionId] = i;
                            if (!this.scriptSlotMap[i]) this.scriptSlotMap[i] = [];
                            this.scriptSlotMap[i].push({
                                ownerId,
                                chunkId: chunk.id,
                                sectionId,
                                slotId: i,
                                lnamSectionId
                            });
                            if (!this.scriptSectionMap[sectionId]) this.scriptSectionMap[sectionId] = [];
                            this.scriptSectionMap[sectionId].push({
                                ownerId,
                                chunkId: chunk.id,
                                sectionId,
                                slotId: i,
                                lnamSectionId
                            });
                            if (lnamSectionId > -1) {
                                this.scriptToLnam[sectionId] = lnamSectionId;
                            }
                        }
                    }

                }
                this.scriptContexts.push(context);
            } catch (e) {

                this.extractor.log('ERROR', `Failed to parse LCTX chunk ${chunk.id}: ${e.message}`);
            }
        }

        let ambiguousSlots = 0;
        for (const [slotId, refs] of Object.entries(this.scriptSlotMap)) {
            const uniqueSections = [...new Set(refs.map(ref => ref.sectionId))];
            if (uniqueSections.length === 1) {
                this.lctxMap[slotId] = uniqueSections[0];
            } else if (uniqueSections.length > 1) {
                ambiguousSlots++;
            }
        }

        this.extractor.log(
            'INFO',
            `[MetadataManager] Parsed LCTX: contexts=${this.scriptContexts.length}, uniqueSlots=${Object.keys(this.lctxMap).length}, ambiguousSlots=${ambiguousSlots}`
        );
    }

    async parseMCsL() {
        // Priority 1: Generic MCsL/abmc tag
        let mcslChunks = this.extractor.dirFile.getChunksByType(Magic.MCsL).concat(this.extractor.dirFile.getChunksByType(Magic.abmc));
        let mcslChunk = mcslChunks[0];

        let foundViaTag = null;
        // Priority 2: CAS* tag from KEY* table (Authoritative for Afterburner)
        if (!mcslChunk) {
            for (const castId in this.keyTable) {
                const map = this.keyTable[castId];
                if (map[Magic.CAS_STAR] || map[Magic.cas_star]) {
                    const sectionId = map[Magic.CAS_STAR] || map[Magic.cas_star];
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
            const mcslType = DirectorFile.unprotect(mcslChunk.type);
            const use32 = (foundViaTag === Magic.CAS_STAR || mcslType === Magic.CAS_STAR || mcslType === Magic.cas_star) && (data.length % 4 === 0);

            this.extractor.castOrder = [];
            let slotIndex = 1;
            while (ds.position + (use32 ? 4 : 2) <= data.length) {
                const sectionId = use32 ? ds.readUint32() : ds.readUint16();
                if (sectionId === 0) {
                    slotIndex++;
                    continue;
                }
                const memberId = this.resolveMemberIdFromResource(sectionId) || sectionId;
                this.extractor.castOrder[slotIndex] = memberId;
                slotIndex++;
            }

        } catch (e) {
            this.extractor.log('ERROR', `Failed to parse MCsL: ${e.message}`);
        }
    }

    async parseNameTable() {
        const lnamChunks = this.extractor.dirFile.getChunksByType(Magic.LNAM).concat(this.extractor.dirFile.getChunksByType(AfterburnerTags.manL));
        
        this.nameTables = [];
        for (const lnam of lnamChunks) {
            const data = await this.extractor.dirFile.getChunkData(lnam);
            if (data) {
                const names = this.extractor.lnamParser.parse(data, 'big');
                const chunkIndex = this.extractor.dirFile.chunks.indexOf(lnam);
                this.nameTables.push({ index: chunkIndex, names, id: lnam.id });
            }
        }

        // Sort by physical index to ensure "nearest preceding" logic works
        this.nameTables.sort((a, b) => a.index - b.index);

        // Fallback for generic nameTable property if anyone still uses it
        this.nameTable = this.nameTables.length > 0 ? this.nameTables[0].names : [];
    }

    /**
     * Resolves the nearest preceding name table for a script at a given chunk index.
     * @param {number} scriptChunkIndex - The index of the script chunk in dirFile.chunks
     * @returns {string[]} - The symbol array from the closest preceding LNAM chunk.
     */
    /**
     * Resolves the correct name table for a script based on LctX mapping.
     */
    getNameTableForScript(scriptLogicalId) {
        const lnamId = this.scriptToLnam[scriptLogicalId];
        if (lnamId !== undefined) {
            const table = this.nameTables.find(nt => nt.id === lnamId);
            if (table) {
                return table.names;
            }
        }

        // Fallback: nearest preceding LNAM (Original heuristic)
        if (!this.nameTables || this.nameTables.length === 0) return [];
        
        // Find chunk index for scriptLogicalId to support preceding logic
        const scriptChunk = this.extractor.dirFile.chunks.find(c => (this.invFmap && this.invFmap[c.id] === scriptLogicalId) || c.id === scriptLogicalId);
        const scriptChunkIndex = scriptChunk ? this.extractor.dirFile.chunks.indexOf(scriptChunk) : -1;

        let bestNT = this.nameTables[0].names;
        let bestIndex = this.nameTables[0].index;

        for (const nt of this.nameTables) {
            if (scriptChunkIndex !== -1 && nt.index < scriptChunkIndex) {
                bestNT = nt.names;
                bestIndex = nt.index;
            } else if (scriptChunkIndex !== -1) {
                break;
            }
        }
        return bestNT;
    }

    /**
     * Resolves a palette cast slot number to its actual section ID.
     * @param {number} paletteId - The cast slot number from paletteId
     * @returns {number|null} - The section ID of the palette, or null if not found
     */
    resolvePaletteId(paletteId) {
        if (!paletteId) return null;

        /**
         * [Director Logical Resolution Hierarchy]
         * 1. Direct Member ID: If paletteId matches a KEY table entry for a Palette.
         * 2. Logical Slot Index: paletteId - minMember + 1 (The base 1-based index).
         * 3. Physical Slot Index: Direct use of paletteId as slot number (Safe for D4+).
         * 4. CastList Fallback: Check implicit KEY order if MCsL is missing.
         */

        const checkMember = (id) => {
            const map = this.keyTable[id];
            if (map && (map[Magic.CLUT] || map[Magic.clut_lower] || map[Magic.Palt] || map[Magic.palt_lower] || map[Magic.PALT_UPPER])) {
                return id;
            }
            return null;
        };

        const minMember = (this.movieConfig && this.movieConfig.minMember !== undefined) ? this.movieConfig.minMember : 1;
        const slotIndex = paletteId - minMember + 1;
        let resolved = null;

        // 1. Logical Slot Index Mapping (Highest Priority in complex Projector contexts)
        // If we have an explicit castOrder (MCsL), the paletteId usually refers to a slot.
        if (this.extractor.castOrder && slotIndex > 0 && slotIndex < this.extractor.castOrder.length) {
            resolved = checkMember(this.extractor.castOrder[slotIndex]);
            if (resolved) {
                return resolved;
            }
        }

        // 2. Direct KeyTable Match (Direct physical ID access)
        resolved = checkMember(paletteId);
        if (resolved) return resolved;

        // 3. Fallback to Implicit Cast List (if MCsL is missing)
        if (this.castList && slotIndex > 0 && slotIndex < this.castList.length) {
            resolved = checkMember(this.castList[slotIndex]);
            if (resolved) return resolved;
        }

        // 4. Fallback: Try paletteId as a direct Physical Slot Index
        if (this.extractor.castOrder && paletteId > 0 && paletteId < this.extractor.castOrder.length) {
            resolved = checkMember(this.extractor.castOrder[paletteId]);
            if (resolved) return resolved;
        }
        if (this.castList && paletteId > 0 && paletteId < this.castList.length) {
            resolved = checkMember(this.castList[paletteId]);
            if (resolved) return resolved;
        }

        // [Ambiguity Fix] If paletteId is very small (e.g. 1-16) and and castOrder[paletteId] 
        // yields a Member with a different ID, it's likely a Slot Index reference.
        // If it still fails, check the lctxMap which often bridges the gap in Afterburner.

        // 4. LctX map lookup (Legacy fallback)
        const lctxRefs = this.scriptSlotMap[paletteId] || [];
        for (const ref of lctxRefs) {
            const memberId = this.resolveMemberIdFromResource(ref.sectionId) || ref.sectionId;
            resolved = checkMember(memberId);
            if (resolved) return resolved;
        }

        return null;
    }


    async parseMemberMetadata(chunk, existingMember = null) {
        const type = DirectorFile.unprotect(chunk.type);
        const data = await this.extractor.dirFile.getChunkData(chunk);
        if (!data) return null;

        this.ensureInvFmap();
        const logicalId = (this.invFmap && this.invFmap[chunk.id] !== undefined) ? this.invFmap[chunk.id] : chunk.id;
        const memberIdFromRes = this.resolveMemberIdFromResource(logicalId) || logicalId;

        const member = CastMember.fromChunk(memberIdFromRes, data, this.extractor.dirFile.ds.endianness);
        member._chunkIndex = this.extractor.dirFile.chunks.indexOf(chunk);



        // Attempt to capture legacy internal ID (Slot ID) from CASt header
        if (data.length >= Offsets.Cast.HeaderSize + 4) {
            const ds = new DataStream(data, 'big');
            ds.seek(Offsets.Cast.SlotId);
            member.originalSlotId = ds.readUint32();
        }

        // Resolve Descriptive Name from LNAM Pool
        // Hierarchy:
        // 1. (Removed, was incorrect LNAM mapping)

        // 2. Slot Index mapping (Director 4+ legacy fallback)
        // 3. Resource ID table lookup


        // Final Default: Generic member_ID
        if (!member.name) member.name = `member_${memberIdFromRes}`;
        member.name = member.name.trim();

        // Initial Metadata Hash (Header Hash)
        // This acts as a placeholder until the Worker replaces it with a content hash.
        const hash = crypto.createHash('sha256');
        hash.update(data);
        hash.update(member.name);
        hash.update(CastMember.getTypeName(member.typeId));
        member.checksum = `header:${hash.digest('hex').substring(0, 8)}`;

        // Primary lookup: try to find an existing member by the reliable resource-mapped ID first.
        // Fallback to originalSlotId only if valid (> 0), as slots are deterministic identity anchors.
        const targetMember = existingMember ||
            this.extractor.members.find(m => m.id === member.id) ||
            (member.originalSlotId > 0 ? this.extractor.members.find(m => m.id === member.originalSlotId) : null);

        if (targetMember) {
            // Merging by originalSlotId is safe as it represents the same physical cast slot,
            // even if referenced via different implicit linkage paths (ILS).
            targetMember.mergeProperties(member);
            return targetMember;
        }

        return member;
    }
    async parseDRCF() {
        const drcfChunks = [Magic.DRCF, Magic.VWCF, Magic.fgrD].flatMap(tag => this.extractor.dirFile.getChunksByType(tag));
        const drcf = drcfChunks[0];
        if (!drcf) return;

        const data = await this.extractor.dirFile.getChunkData(drcf);
        if (!data || data.length < 32) return;

        try {
            const ds = new DataStream(data, 'big');
            const len = ds.readInt16();

            ds.seek(12);
            const minMember = ds.readInt16();
            const maxMember = ds.readInt16();

            // Extract Director File Version for structure offsets
            ds.seek(2);
            const fileVersion = ds.readUint16();

            let version = fileVersion;
            // Post D3 Check: The version field was added in D3 at offset 36
            if (data.length > 38) {
                ds.seek(36);
                version = ds.readInt16();
            }

            let paletteId = -1; // Default to Macintosh System Palette

            // kFileVer400 (0x400) to kFileVer500 (0x4B1)
            if (version >= 0x400 && version < 0x4B1) {
                if (data.length >= 50) {
                    ds.seek(48);
                    paletteId = ds.readInt16();
                }
            } else if (version >= 0x4B1) { // kFileVer500+
                if (data.length >= 58) {
                    ds.seek(56);
                    paletteId = ds.readInt16();
                }
            }

            // Normalize built-in palette IDs via centralized helper
            paletteId = Palette.normalizePaletteId(paletteId);

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
