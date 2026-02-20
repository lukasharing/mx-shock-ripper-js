const CastMember = require('../CastMember');
const { MemberType, Magic, Limits, AfterburnerTags } = require('../Constants');
const DirectorFile = require('../DirectorFile');

class CastManager {
    constructor(extractor) {
        this.extractor = extractor;
        this.members = [];
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
            if (!this.members.find(m => m.id === memberId)) {
                this.members.push(new CastMember(memberId, null, {
                    name: `member_${memberId}`
                }));
            }
        }

        this.applyHeuristics();
    }

    /**
     * Initial Type Heuristics (Pre-enrichment)
     */
    applyHeuristics() {
        const metadata = this.extractor.metadataManager;
        for (const member of this.members) {
            const map = metadata.keyTable[member.id];
            if (map) {
                if (map[Magic.BITD] || map[Magic.ABMP] || map[Magic.DIB] || map[Magic.PIXL]) member.typeId = MemberType.Bitmap;
                else if (map[Magic.CLUT] || map[Magic.Palt] || map[Magic.palt_lower] || map[Magic.PALT_UPPER]) member.typeId = MemberType.Palette;
                else if (map[Magic.STXT] || map[Magic.text_lower] || map[Magic.TXTS]) member.typeId = MemberType.Text;
                else if (map[Magic.Lscl] || map[Magic.LSCR] || map[Magic.LSCR_UPPER]) member.typeId = MemberType.Script;
                else if (map[Magic.SND] || map[Magic.snd] || map[Magic.SND_STAR]) member.typeId = MemberType.Sound;
                else if (map[Magic.XTRA] || map[Magic.XTCL]) member.typeId = MemberType.Xtra;
                else if (map[Magic.SHAP]) member.typeId = MemberType.Shape;
                else if (map[Magic.FONT] || map[Magic.VWFT]) member.typeId = MemberType.Font;
            }
        }
    }

    /**
     * [Enrichment Pass 1] Map-based (Standard Files)
     */
    async enrichPass1() {
        const metadata = this.extractor.metadataManager;
        for (const member of this.members) {
            const map = metadata.keyTable[member.id];
            const sectionId = map ? (map[Magic.CAST] || map[Magic.CAS_STAR] || map[Magic.CArT] || map[Magic.cast_lower]) : null;
            const chunk = sectionId ? this.extractor.dirFile.getChunkById(sectionId) : null;
            if (chunk) {
                await metadata.parseMemberMetadata(chunk, member);
            }
        }
    }

    /**
     * [Enrichment Pass 2] Global Scan (Afterburner / Headless Files)
     */
    async enrichPass2() {
        const metadata = this.extractor.metadataManager;
        const orphans = [];

        for (const chunk of this.extractor.dirFile.chunks) {
            const rawType = DirectorFile.unprotect(chunk.type);
            const normalized = this.normalizeTag(rawType);
            const trimmed = rawType.trim();

            // 1. Metadata Reconstruction
            if (normalized === Magic.CAST || normalized === Magic.CAS_STAR || normalized === 'CAS2') {
                const member = await metadata.parseMemberMetadata(chunk);
                if (member && !this.getMemberById(member.id)) {
                    this.members.push(member);
                }
            } else {
                // 2. Orphan Content Detection
                const contentTags = [Magic.BITD, Magic.ABMP, Magic.SND, Magic.DIB, Magic.PIXL, Magic.STXT, Magic.TXTS, Magic.CLUT, Magic.PALT_UPPER, Magic.medi, Magic.snd, Magic.ABMP, Magic.bitd_lower, Magic.text_lower, Magic.PMBA, Magic.ediM, 'SND*', Magic.manL, Magic.rcsL];
                if (contentTags.includes(normalized) || contentTags.includes(trimmed)) {
                    orphans.push({ chunk, tag: normalized });
                }
            }
        }

        // Association Pass: Try to link orphans to members
        // Afterburner files often have detached content chunks (BITD/medi) that are 
        // not explicitly linked in the KEY* table but share a Resource ID or Slot ID.
        for (const orphan of orphans) {
            const { chunk, tag } = orphan;
            const memberId = metadata.resToMember[chunk.id] || chunk.id;
            let member = this.getMemberById(memberId);

            if (!member && memberId > 0 && memberId < Limits.MaxCastSlots) {
                // Heuristic Recovery: Create skeleton if metadata is missing but content exists
                let initialType = MemberType.Null;
                if (tag === Magic.BITD || tag === Magic.ABMP || tag === Magic.DIB || tag === Magic.bitd_lower || tag === Magic.ABMP || tag === Magic.PIXL || tag === Magic.rcsL) initialType = MemberType.Bitmap;
                else if (tag === Magic.STXT || tag === Magic.TXTS || tag === Magic.text_lower) initialType = MemberType.Text;
                else if (tag === Magic.CLUT || tag === Magic.PALT_UPPER || tag === Magic.palt_lower) initialType = MemberType.Palette;
                else if (tag === Magic.SND || tag === Magic.snd || tag === 'SND*') initialType = MemberType.Sound;
                else if (tag === Magic.SHAP) initialType = MemberType.Shape;
                else if (tag === Magic.XTRA || tag === Magic.XTCL) initialType = MemberType.Xtra;
                else if (tag === Magic.FONT || tag === Magic.VWFT) initialType = MemberType.Font;
                else if (tag === Magic.manL) initialType = MemberType.Null; // manL is an Afterburner LNAM (name table) chunk, not a palette

                member = new CastMember(memberId, null, {
                    name: `member_${memberId}`,
                    typeId: initialType
                });
                this.members.push(member);
            }

            if (member) {
                // Map Afterburner aliases to standard tags for the extractor
                let finalTag = tag;
                if (tag === Magic.ABMP || tag === Magic.PMBA || tag === Magic.DIB || tag === Magic.bitd_lower) finalTag = Magic.BITD;
                if (tag === Magic.medi || tag === Magic.ediM) finalTag = Magic.medi;
                if (tag === Magic.snd || tag === 'SND*' || tag === Magic.snd) finalTag = Magic.SND;
                if (tag === Magic.text_lower || tag === Magic.STXT || tag === Magic.stxt_lower) finalTag = Magic.STXT;
                if (tag === Magic.manL) finalTag = Magic.LNAM;

                if (!metadata.keyTable[member.id]) metadata.keyTable[member.id] = {};
                if (!metadata.keyTable[member.id][finalTag]) {
                    metadata.keyTable[member.id][finalTag] = chunk.id;
                    this.extractor.log('DEBUG', `[FullGlobalScan] Linked orphan chunk ${chunk.type} (${finalTag}) ${chunk.id} to member ${member.id}`);
                }
            }
        }

        // 3. Proactive Naming Pass (Afterburner Orphan Recovery)
        if (metadata.nameTable && metadata.nameTable.length > 0) {
            for (const member of this.members) {
                if (member.name.startsWith('member_')) {
                    // In Afterburner, the name table index often matches the member ID - 1
                    const recoveredName = metadata.nameTable[member.id - 1];
                    if (recoveredName) {
                        this.extractor.log('DEBUG', `[CastManager] Recovered name for orphan ${member.id}: ${recoveredName}`);
                        member.name = recoveredName;
                    }
                }
            }
        }
    }

    getMemberById(id) {
        return this.members.find(m => m.id === id);
    }

    normalizeTag(tag) {
        if (!tag) return '';
        const t = tag.trim();
        return AfterburnerTags[t] || AfterburnerTags[tag] || t;
    }
}

module.exports = CastManager;
