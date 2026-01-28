const crypto = require('crypto');
const DirectorFile = require('../DirectorFile');
const CastMember = require('../CastMember');
const DataStream = require('../utils/DataStream');
const { Magic, AfterburnerTags, MemberType } = require('../Constants');

class MetadataManager {
    constructor(extractor) {
        this.extractor = extractor;
        this.keyTable = {};
        this.resToMember = {};
        this.nameTable = {};
        this.lctxMap = {};
    }

    async parseKeyTable() {
        const keyChunk = this.extractor.dirFile.chunks.find(c => {
            const unprot = DirectorFile.unprotect(c.type).toUpperCase();
            return unprot === 'KEY*' || unprot === 'KEY ';
        });
        if (!keyChunk) return;

        const data = await this.extractor.dirFile.getChunkData(keyChunk);
        if (!data) return;

        const ds = new DataStream(data, this.extractor.dirFile.ds.endianness);
        let firstWord = ds.readUint16();

        if (firstWord === 0x4B45 || firstWord === 0x454B) {
            ds.seek(0);
            ds.readFourCC();
            firstWord = ds.readUint16();
        }

        if (firstWord > 255) {
            ds.endianness = ds.endianness === 'big' ? 'little' : 'big';
            ds.seek(2);
            firstWord = ds.readUint16();
        }

        let headerSize = firstWord === 12 ? 12 : 20;

        // Safety check: if buffer is too small for 20-byte header, downgrade to 12 (or abort if too small for 12)
        if (headerSize === 20 && data.length < 20) {

            headerSize = 12;
        }
        if (data.length < 12) {

            return;
        }

        let usedCount;

        if (headerSize === 12) {
            ds.seek(4); // Skip firstWord(2) + 2 bytes padding/version?
            // Actually lines 45-47: ds.readUint16(); ds.readUint32(); usedCount = ds.readUint32();
            // Original code:
            // if (headerSize === 12) {
            //     ds.readUint16(); // 2 bytes (pos 2->4)
            //     ds.readUint32(); // 4 bytes (pos 4->8)
            //     usedCount = ds.readUint32(); // 4 bytes (pos 8->12)
            // }
            // Since we read firstWord (2 bytes) at line 27, ds is at 2.
            ds.readUint16();
            ds.readUint32();
            usedCount = ds.readUint32();
        } else {
            ds.seek(12);
            // Check bounds before read
            if (ds.position + 4 > data.length) {

                return;
            }
            ds.readUint32();
            usedCount = ds.readUint32();
        }

        ds.seek(headerSize);
        for (let i = 0; i < usedCount; i++) {
            if (ds.position + 12 > data.length) break;
            const sectionID = ds.readInt32();
            const castID = ds.readInt32();
            const tag = ds.readFourCC();
            const normalizedTag = DirectorFile.unprotect(tag);

            if (!this.keyTable[castID]) this.keyTable[castID] = {};
            this.keyTable[castID][normalizedTag] = sectionID;
            this.resToMember[sectionID] = castID;
        }

        // Script mappings from LCTX
        const lctxChunks = this.extractor.dirFile.chunks.filter(c => {
            const unprot = DirectorFile.unprotect(c.type).toUpperCase();
            return unprot === 'LCTX' || unprot === 'XTCL';
        });

        for (const chunk of lctxChunks) {
            const data = await this.extractor.dirFile.getChunkData(chunk);
            if (!data || data.length < 18) continue;

            const ds = new DataStream(data, 'big');
            ds.skip(8);
            const entryCount = ds.readUint32();
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
                        this.lctxMap[i] = sectionId;
                    }
                }
            }
        }
    }

    async parseNameTable() {
        const lnam = this.extractor.dirFile.chunks.find(c => c.type === Magic.LNAM || c.type === AfterburnerTags.manL);
        if (lnam) {
            const data = await this.extractor.dirFile.getChunkData(lnam);
            if (data) this.nameTable = this.extractor.lnamParser.parse(data, this.extractor.dirFile.ds.endianness);
        }
    }

    async parseLctxMap() {
        const lctxChunks = this.extractor.dirFile.chunks.filter(c => {
            const unprot = DirectorFile.unprotect(c.type).toUpperCase();
            return unprot === Magic.LCTX.toUpperCase() || unprot === AfterburnerTags.XtcL.toUpperCase();
        });

        for (const chunk of lctxChunks) {
            const data = await this.extractor.dirFile.getChunkData(chunk);
            if (!data || data.length < 8) continue;

            const ds = new DataStream(data, this.extractor.dirFile.ds.endianness);
            ds.skip(8);

            const scriptId = this.resToMember[chunk.id];
            if (scriptId) {
                this.lctxMap[scriptId] = chunk.id;
            }
        }
    }

    async parseMemberMetadata(chunk) {
        const data = await this.extractor.dirFile.getChunkData(chunk);
        if (!data) return null;

        const memberId = this.resToMember[chunk.id] || chunk.id;
        const member = CastMember.fromChunk(memberId, data, this.extractor.dirFile.ds.endianness);

        member.checksum = crypto.createHash('sha256').update(data).digest('hex');
        if (!member.name) member.name = `member_${memberId}`;
        member.name = member.name.replace(/[^a-zA-Z0-9_\-]/g, '_').trim();

        const typeName = CastMember.getTypeName(member.typeId);
        this.extractor.stats.total++;
        this.extractor.stats.byType[typeName] = (this.extractor.stats.byType[typeName] || 0) + 1;

        this.extractor.members.push(member);
        return member;
    }
}

module.exports = MetadataManager;
