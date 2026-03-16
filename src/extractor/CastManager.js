/**
 * @version 1.4.2
 * CastManager.js - Centralized member discovery and state management
 */
const CastMember = require('../CastMember');
const { MemberType, Magic, Limits, AfterburnerTags } = require('../Constants');
const DirectorFile = require('../DirectorFile');

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

        // 2. From LctX (ILS mapping)
        for (const logicalId in metadata.lctxMap) {
            const sectionId = metadata.lctxMap[logicalId];
            const memberId = metadata.resToMember[sectionId] || parseInt(logicalId);
            if (memberId > 0) discoveredIds.add(memberId);
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
                // Image / Bitmap
                if (map[Magic.BITD] || map[Magic.ABMP] || map[Magic.DIB] || map[Magic.PIXL] || map[Magic.ILBM]) member.typeId = MemberType.Bitmap;
                // Palette
                else if (map[Magic.CLUT] || map[Magic.Palt] || map[Magic.palt_lower] || map[Magic.PALT_UPPER]) member.typeId = MemberType.Palette;
                // Text
                else if (map[Magic.STXT] || map[Magic.TEXT] || map[Magic.text_lower] || map[Magic.TXTS]) member.typeId = MemberType.Text;
                // Script
                else if (map[Magic.Lscl] || map[Magic.LSCR] || map[Magic.LSCR_UPPER]) member.typeId = MemberType.Script;
                // Sound
                else if (map[Magic.SND] || map[Magic.snd] || map[Magic.SND_STAR]) member.typeId = MemberType.Sound;
                // Xtra
                else if (map[Magic.XTRA] || map[Magic.XTCL]) member.typeId = MemberType.Xtra;
                // Shape
                else if (map[Magic.SHAP]) member.typeId = MemberType.Shape;
                // Font
                else if (map[Magic.FONT] || map[Magic.VWFT]) member.typeId = MemberType.Font;
                // Digital Video
                else if (map[Magic.MooV] || map[Magic.VdM]) member.typeId = MemberType.DigitalVideo;
                // Flash
                else if (map[Magic.Flas]) member.typeId = MemberType.Flash;
                // Transitions
                else if (Object.keys(map).some(k => k.startsWith('Fx'))) member.typeId = MemberType.Transition;
                // Cursor
                else if (map[Magic.MCrs]) member.typeId = MemberType.Bitmap; // Cursors are typically bitmaps
                // Picture
                else if (map[Magic.PICT]) member.typeId = MemberType.Picture;
            }
            // Deterministic structural association:
            // If the member ID is explicitly mapped as a Script inside an Lctx (ScriptContext) block,
            // it is structurally defined as a Script by the engine, regardless of missing CASt chunk.
            if (Object.values(metadata.lctxMap).includes(member.id) || Object.keys(metadata.lctxMap).includes(member.id.toString())) {
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

        // 1. Metadata Reconstruction & Orphan Detection
        const contentTags = [
            Magic.LSCR, Magic.Lscl, Magic.BITD, Magic.ABMP, Magic.SND, Magic.DIB, Magic.PIXL,
            Magic.STXT, Magic.TXTS, Magic.TEXT, Magic.text_lower, Magic.stxt_lower, Magic.CLUT, Magic.PALT_UPPER, Magic.medi, Magic.snd,
            Magic.ABMP, Magic.bitd_lower, Magic.PMBA, Magic.ediM, 'SND*',
            Magic.manL, Magic.rcsL, Magic.MooV, Magic.VdM, Magic.Flas, Magic.MCrs, Magic.PICT
        ];

        const chunks = this.extractor.dirFile.chunks;
        await Promise.all(chunks.map(async (chunk) => {
            const rawType = DirectorFile.unprotect(chunk.type);
            const normalized = this.normalizeTag(rawType);
            const trimmed = rawType.trim();

            if (normalized === Magic.CAST || normalized === Magic.CAS_STAR || normalized === 'CAS2') {
                const member = await metadata.parseMemberMetadata(chunk);
                if (member && !this.memberMap.has(member.id)) {
                    this.members.push(member);
                    this.memberMap.set(member.id, member);
                }
            } else if (contentTags.includes(normalized) || contentTags.includes(trimmed) || normalized.startsWith('Fx')) {
                orphans.push({ chunk, tag: normalized });
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
            const { chunk, tag } = orphan;

            const logicalId = (metadata.invFmap && metadata.invFmap[chunk.id] !== undefined) ? metadata.invFmap[chunk.id] : chunk.id;
            const memberId = metadata.resToMember[logicalId] || logicalId;

            if (tag === Magic.STXT || tag === Magic.TEXT || tag === Magic.stxt_lower || tag === Magic.text_lower || memberId === 105) {
                this.extractor.log('INFO', `[CastManager] Orphan Chunk ${chunk.id} (logical ${logicalId}, tag ${tag}) -> Member ${memberId}`);
            }

            // Scripts (LSCR) are mapped via LCTX, not KEY* table or 1:1 ID matching.
            if (tag === Magic.LSCR || tag === Magic.Lscl) {
                continue; // Do not create phantom skeleton members for LSCR
            }

            let member = this.getMemberById(memberId);

            if (!member && memberId > 0 && memberId < Limits.MaxCastSlots) {
                // Structural Recovery: Create skeleton if metadata is missing but deterministic content exists
                let initialType = MemberType.Null;
                if (tag === Magic.BITD || tag === Magic.ABMP || tag === Magic.DIB || tag === Magic.bitd_lower || tag === Magic.PIXL || tag === Magic.rcsL || tag === Magic.MCrs) initialType = MemberType.Bitmap;
                else if (tag === Magic.STXT || tag === Magic.TXTS || tag === Magic.text_lower) initialType = MemberType.Text;
                else if (tag === Magic.CLUT || tag === Magic.PALT_UPPER || tag === Magic.palt_lower) initialType = MemberType.Palette;
                else if (tag === Magic.SND || tag === Magic.snd || tag === 'SND*') initialType = MemberType.Sound;
                else if (tag === Magic.SHAP) initialType = MemberType.Shape;
                else if (tag === Magic.XTRA || tag === Magic.XTCL) initialType = MemberType.Xtra;
                else if (tag === Magic.FONT || tag === Magic.VWFT) initialType = MemberType.Font;
                else if (tag === Magic.MooV || tag === Magic.VdM) initialType = MemberType.DigitalVideo;
                else if (tag === Magic.Flas) initialType = MemberType.Flash;
                else if (tag === Magic.PICT) initialType = MemberType.Picture;
                else if (tag.startsWith('Fx')) initialType = MemberType.Transition;
                else if (tag === Magic.manL) initialType = MemberType.Null; // manL is an Afterburner LNAM (name table) chunk, not a palette

                member = new CastMember(memberId, null, {
                    name: `member_${memberId}`,
                    typeId: initialType
                });
                this.members.push(member);
                this.memberMap.set(memberId, member);
            }

            if (member) {
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

                // Map Afterburner aliases to standard tags for the extractor
                let finalTag = tag;
                if (tag === Magic.ABMP || tag === Magic.PMBA || tag === Magic.DIB || tag === Magic.bitd_lower) finalTag = Magic.BITD;
                if (tag === Magic.medi || tag === Magic.ediM) finalTag = Magic.medi;
                if (tag === Magic.snd || tag === 'SND*' || tag === Magic.snd) finalTag = Magic.SND;
                if (tag === Magic.text_lower || tag === Magic.STXT || tag === Magic.stxt_lower || tag === Magic.TEXT) finalTag = Magic.STXT;
                if (tag === Magic.manL) finalTag = Magic.LNAM;

                if (!metadata.keyTable[member.id]) metadata.keyTable[member.id] = {};
                if (!metadata.keyTable[member.id][finalTag]) {
                    metadata.keyTable[member.id][finalTag] = chunk.id;
                }
            } else {
                if (tag === Magic.STXT || tag === Magic.TEXT || tag === Magic.stxt_lower || tag === Magic.text_lower) {
                    this.extractor.log('WARNING', `[CastManager] Failed to find member for orphaned text chunk ${chunk.id} (Member ${memberId})`);
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
        return AfterburnerTags[t] || AfterburnerTags[tag] || t;
    }
}

module.exports = CastManager;
