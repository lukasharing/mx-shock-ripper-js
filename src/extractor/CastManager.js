/**
 * @version 1.4.2
 * CastManager.js - Centralized member discovery and state management
 */
const CastMember = require('../CastMember');
const { MemberType, Magic, Limits, AfterburnerTags } = require('../Constants');
const DirectorFile = require('../DirectorFile');
const { detectMemberTypeFromMap, detectMemberTypeFromTag } = require('../utils/MemberContent');

class CastManager {
    constructor(extractor) {
        this.extractor = extractor;
        this.members = [];
        this.memberMap = new Map();
        this._sortedPalettes = null;
    }

    /**
     * Aggregates all unique Member IDs from structural metadata (KEY*, LctX, MCsL).
     */
    async discoverMembers() {
        const metadata = this.extractor.metadataManager;
        const discoveredIds = new Set();

        // 1. From KEY* table
        for (const castIdStr in metadata.keyTable) {
            discoveredIds.add(parseInt(castIdStr));
        }

        // 2. From LctX script contexts
        for (const [logicalId, refs] of Object.entries(metadata.scriptSlotMap || {})) {
            const slotId = parseInt(logicalId, 10);
            const seenSections = new Set();
            for (const ref of refs) {
                if (!ref || seenSections.has(ref.sectionId)) continue;
                seenSections.add(ref.sectionId);
                const memberId = metadata.resolveMemberIdFromResource(ref.sectionId) || slotId;
                if (memberId > 0) discoveredIds.add(memberId);
            }
        }

        // 3. From Cast Order (MCsL / CAS*)
        if (this.extractor.castOrder) {
            this.extractor.castOrder.forEach(id => {
                if (id > 0) discoveredIds.add(id);
            });
        }

        // Initialize member instances
        for (const memberId of discoveredIds) {
            if (memberId >= Limits.MaxCastSlots) continue;
            if (!this.memberMap.has(memberId)) {
                const member = new CastMember(memberId, null, {
                    name: `member_${memberId}`
                });
                this.members.push(member);
                this.memberMap.set(memberId, member);
            }
        }

        this.assignTypes();
    }

    /**
     * Deterministic Type Assignment (Pre-enrichment)
     * Assigns MemberType based strictly on the presence of authoritative data chunks.
     * Replaces previous heuristic guesses with 1:1 chunk-to-type mappings.
     */
    assignTypes() {
        const metadata = this.extractor.metadataManager;
        for (const member of this.members) {
            const map = metadata.keyTable[member.id];
            if (map) {
                const detectedType = detectMemberTypeFromMap(map);
                if (detectedType !== null) {
                    member.typeId = detectedType;
                }
            }
            // Deterministic structural association:
            // If the member ID is explicitly mapped as a Script inside an Lctx (ScriptContext) block,
            // it is structurally defined as a Script by the engine, regardless of missing CASt chunk.
            if (metadata.hasScriptContextReference(member.id)) {
                member.typeId = MemberType.Script;
            }
        }
    }

    /**
     * [Enrichment Pass 1] Map-based (Standard Files)
     */
    async enrichPass1() {
        const metadata = this.extractor.metadataManager;
        await Promise.all(this.members.map(async (member) => {
            const map = metadata.keyTable[member.id];
            const sectionId = map ? (map[Magic.CAST] || map[Magic.CAS_STAR] || map[Magic.CArT] || map[Magic.cast_lower]) : null;
            const chunk = sectionId ? this.extractor.dirFile.getChunkById(sectionId) : null;
            if (chunk) {
                await metadata.parseMemberMetadata(chunk, member);
            }
        }));
    }

    /**
     * [Enrichment Pass 2] Global Scan (Afterburner / Headless Files)
     */
    async enrichPass2() {
        const metadata = this.extractor.metadataManager;
        const orphans = [];
        metadata.ensureInvFmap();

        const chunks = this.extractor.dirFile.chunks;
        await Promise.all(chunks.map(async (chunk) => {
            const rawType = DirectorFile.unprotect(chunk.type);
            const normalized = this.normalizeTag(rawType);
            const trimmed = rawType.trim();
            const detectedType = detectMemberTypeFromTag(normalized) || detectMemberTypeFromTag(trimmed);

            if (normalized === Magic.CAST || normalized === Magic.CAS_STAR || normalized === 'CAS2') {
                const member = await metadata.parseMemberMetadata(chunk);
                if (member && !this.memberMap.has(member.id)) {
                    this.members.push(member);
                    this.memberMap.set(member.id, member);
                }
            } else if (detectedType !== null) {
                orphans.push({ chunk, tag: normalized, detectedType });
            } else {
                // Log unhandled tags that might be relevant
                if (normalized.length === 4 && !normalized.includes('\0')) {
                    // this.extractor.log('DEBUG', `[CastManager] Potential content tag ignored: ${normalized} (chunk ${chunk.id})`);
                }
            }
        }));

        this.extractor.log('INFO', `[CastManager] Found ${orphans.length} potential orphan chunks.`);

        // Association Pass: Try to link orphans to members
        // Afterburner files often have detached content chunks (BITD/medi) that are 
        // not explicitly linked in the KEY* table but share a Resource ID or Slot ID.
        for (const orphan of orphans) {
            const { chunk, tag, detectedType } = orphan;

            const logicalId = (metadata.invFmap && metadata.invFmap[chunk.id] !== undefined) ? metadata.invFmap[chunk.id] : chunk.id;
            const isScriptChunk = tag === Magic.LSCR || tag === Magic.LSCR_UPPER || tag === Magic.Lscl || tag === Magic.rcsL;
            const scriptContextRefs = isScriptChunk
                ? [
                    ...(metadata.scriptSectionMap[logicalId] || []),
                    ...(metadata.scriptSectionMap[chunk.id] || [])
                ]
                : [];
            const contextRef = scriptContextRefs[0] || null;
            const contextMember = contextRef
                ? this.members.find(member => member && member.typeId === MemberType.Script && member.scriptId === contextRef.slotId)
                : null;
            const resolvedMemberId =
                metadata.resolveMemberIdFromResource(logicalId, { allowSelf: false }) ||
                metadata.resolveMemberIdFromResource(chunk.id, { allowSelf: false }) ||
                contextMember?.id ||
                0;
            const memberId = isScriptChunk
                ? (
                    resolvedMemberId ||
                    0
                )
                : (resolvedMemberId || logicalId);

            if (isScriptChunk && memberId <= 0) {
                if (this.extractor.options.verbose === true) {
                    this.extractor.log('DEBUG', `[CastManager] Skipping unattached LSCR chunk ${chunk.id} (logical ${logicalId})`);
                }
                continue;
            }

            if (this.extractor.options.verbose === true && (tag === Magic.STXT || tag === Magic.TEXT || tag === Magic.stxt_lower || tag === Magic.text_lower || memberId === 105)) {
                this.extractor.log('DEBUG', `[CastManager] Orphan Chunk ${chunk.id} (logical ${logicalId}, tag ${tag}) -> Member ${memberId}`);
            }

            let member = this.getMemberById(memberId);

            if (!member && memberId > 0 && memberId < Limits.MaxCastSlots) {
                member = new CastMember(memberId, null, {
                    name: `member_${memberId}`,
                    typeId: detectedType || MemberType.Null
                });
                this.members.push(member);
                this.memberMap.set(memberId, member);
            }

            if (member) {
                if ((member.typeId === MemberType.Null || member.typeId === MemberType.Picture) && detectedType !== null) {
                    member.typeId = detectedType;
                }

                // Deterministic Script Type Parsing (No Heuristics)
                if (tag === Magic.LSCR || tag === Magic.Lscl) {
                    try {
                        const data = await this.extractor.dirFile.getChunkData(chunk);
                        if (data && data.length >= 42) {
                            const flags = data.readUInt32BE(38);
                            // Explicit mapping based on engine's Structural bitmasks (Director architecture)
                            if (flags & 8) member.scriptType = 2;      // Parent
                            else if (flags & 4) member.scriptType = 1; // Behavior
                            else if (flags & 2) member.scriptType = 3; // Movie
                            else member.scriptType = 0;                // Legacy Global/Movie
                        }
                    } catch (e) {

                    }
                }

                if (!metadata.keyTable[member.id]) metadata.keyTable[member.id] = {};
                if (!metadata.keyTable[member.id][tag]) {
                    metadata.keyTable[member.id][tag] = chunk.id;
                }
                metadata.resToMember[logicalId] = member.id;
                metadata.resToMember[chunk.id] = member.id;
            } else {
                if (this.extractor.options.verbose === true) {
                    this.extractor.log('WARNING', `[CastManager] Failed to find member for orphaned ${tag} chunk ${chunk.id} (logical ${logicalId})`);
                }
            }
        }

        // 3. Proactive Naming Pass removed because nameTable represents Lingo variable names and does not correlate with member IDs.
    }

    getMemberById(id) {
        return this.memberMap.get(id) || null;
    }

    /**
     * Returns a sorted list of palette members, cached for performance.
     * Used by Palette.js for O(log N) nearest-preceding search.
     */
    getSortedPalettes() {
        if (this._sortedPalettes) return this._sortedPalettes;
        this._sortedPalettes = this.members
            .filter(m => m.typeId === MemberType.Palette)
            .sort((a, b) => a.id - b.id);
        return this._sortedPalettes;
    }

    invalidateCache() {
        this._sortedPalettes = null;
    }

    normalizeTag(tag) {
        if (!tag) return '';
        const t = tag.trim();
        return DirectorFile.unprotect(t) || DirectorFile.unprotect(tag) || t;
    }
}

module.exports = CastManager;
