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
            const physicalId = metadata.lctxMap[logicalId];
            const memberId = metadata.resToMember[physicalId] || physicalId;
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
                if (map['BITD'] || map['ABMP']) member.typeId = MemberType.Bitmap;
                else if (map['CLUT'] || map['Palt'] || map['palt']) member.typeId = MemberType.Palette;
                else if (map['STXT'] || map['text'] || map['TXTS']) member.typeId = MemberType.Text;
                else if (map['Lscr'] || map['LSCR']) member.typeId = MemberType.Script;
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
            const sectionId = map ? (map[Magic.CAST] || map['CAS*'] || map['CArT'] || map['cast']) : null;
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
            if (normalized === 'CASt' || normalized === 'CAS*' || normalized === 'CAS2') {
                const member = await metadata.parseMemberMetadata(chunk);
                if (member && !this.getMemberById(member.id)) {
                    this.members.push(member);
                }
            } else {
                // 2. Orphan Content Detection
                const contentTags = ['BITD', 'ABMP', 'SND ', 'DIB ', 'PIXL', 'STXT', 'TXTS', 'CLUT', 'PALT', 'medi', 'snd ', 'Abmp', 'bitd', 'text', 'PMBA', 'ediM', 'SND*', 'manL', 'rcsL'];
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
                member = new CastMember(memberId, null, { name: `member_${memberId}` });
                this.members.push(member);
            }

            if (member) {
                // Map Afterburner aliases to standard tags for the extractor
                let finalTag = tag;
                if (tag === 'Abmp' || tag === 'PMBA' || tag === 'DIB ' || tag === 'bitd') finalTag = 'BITD';
                if (tag === 'medi' || tag === 'ediM') finalTag = 'medi';
                if (tag === 'snd ' || tag === 'SND*' || tag === 'snd ') finalTag = 'SND ';
                if (tag === 'text' || tag === 'STXT' || tag === 'stxt') finalTag = 'STXT';
                if (tag === 'manL') finalTag = 'LNAM';

                if (!metadata.keyTable[member.id]) metadata.keyTable[member.id] = {};
                if (!metadata.keyTable[member.id][finalTag]) {
                    metadata.keyTable[member.id][finalTag] = chunk.id;
                    this.extractor.log('DEBUG', `[FullGlobalScan] Linked orphan chunk ${chunk.type} (${finalTag}) ${chunk.id} to member ${member.id}`);
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
