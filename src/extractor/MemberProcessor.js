const path = require('path');
const fs = require('fs');
const { MemberType, Magic } = require('../Constants');
const { Palette } = require('../utils/Palette');
const { Color } = require('../utils/Color');

/**
 * @version 1.3.4
 * MemberProcessor.js - Centralized orchestration for member-specific extraction logic.
 * Handles chunk-to-member mapping and delegates to specialized extractors.
 */
class MemberProcessor {
    constructor(extractor) {
        this.extractor = extractor;
        this.log = (lvl, msg) => extractor.log(lvl, msg);
    }

    /**
     * Resolves necessary chunks for a member and orchestrates its extraction.
     * Called by DirectorExtractor.js during the main processing loop.
     */
    async processMemberContent(member, chunk) {
        const map = this.extractor.metadataManager.keyTable[member.id];

        try {
            // Priority 1: Primary Data Chunk (pixels, text, sound, etc.)
            // We search the key table map for standard content tags.
            const primaryTag = [Magic.BITD, Magic.STXT, Magic.TEXT, Magic.SND, Magic.FONT, Magic.VWFT, Magic.CLUT, Magic.CVWS, Magic.XTRA, Magic.SCORE, Magic.VWSC]
                .find(t => map && map[t]);

            if (primaryTag && map[primaryTag]) {
                member.data = await this.extractor.dirFile.getChunkData(this.extractor.dirFile.getChunkById(map[primaryTag]));
            } else {
                // Fallback: If no explicit primary tag is found in the map, use the chunk passed from the CAST loop.
                member.data = await this.extractor.dirFile.getChunkData(chunk);
            }

            // Priority 2: Alpha Channel (ALFA) - specific to Bitmaps
            if (map && map[Magic.ALFA]) {
                member.alphaData = await this.extractor.dirFile.getChunkData(this.extractor.dirFile.getChunkById(map[Magic.ALFA]));
            }

            // Final delegation to extractor logic
            await this.processMember(member);

        } catch (e) {
            this.log('ERROR', `Failed to process member content for ${member.id} (${member.name}): ${e.message}`);
        }
    }

    /**
     * Specialized processing for a member once its data chunks are resolved.
     */
    async processMember(member) {
        try {
            if (!member || !member.id) return;

            // 1. Determine Output Path
            // Raw member name is preserved, but sanitized for filesystem safety.
            const baseName = member.name || `member_${member.id}`;
            const sanitizedName = baseName.replace(/[/\\?%*:|"<>]/g, '_');
            const outPathPrefix = path.join(this.extractor.outputDir, sanitizedName);

            // 2. Resolve Palette for Bitmaps & Shapes
            let finalPalette = null;
            if (member.typeId === MemberType.Bitmap || member.typeId === MemberType.Shape) {
                finalPalette = Palette.resolveMemberPalette(member, this.extractor);
            }

            // 3. Delegate to specialized extractors based on MemberType
            let result = null;

            switch (member.typeId) {
                case MemberType.Bitmap:
                    result = await this.extractor.bitmapExtractor.extract(member.data, outPathPrefix, member, finalPalette, member.alphaData);
                    break;
                case MemberType.Palette:
                    // Palettes are typically handled early via processPalette, but we provide fallback here.
                    if (member.data) {
                        member.palette = Palette.parseDirector(member.data);
                        result = await this.extractor.paletteExtractor.save(member.palette, outPathPrefix + ".pal", member);
                    }
                    break;
                case MemberType.Script:
                    result = await this.extractor.scriptHandler.processScript(member, outPathPrefix);
                    break;
                case MemberType.Sound:
                    result = await this.extractor.soundExtractor.save(member.data, outPathPrefix, member);
                    break;
                case MemberType.Text:
                case MemberType.Field:
                    result = await this.extractor.textExtractor.save(member.data, outPathPrefix, member);
                    break;
                case MemberType.Shape:
                    result = await this.extractor.shapeExtractor.save(outPathPrefix, member, finalPalette);
                    break;
                case MemberType.Font:
                    result = await this.extractor.fontExtractor.save(member.data, outPathPrefix);
                    break;
                case MemberType.VectorShape:
                    result = await this.extractor.vectorShapeExtractor.save(member.data, outPathPrefix, member);
                    break;
                case MemberType.FilmLoop:
                    result = await this.extractor.movieExtractor.save(member.data, outPathPrefix, member);
                    break;
                default:
                    // Dump unknown or unsupported types as raw binary if they have data.
                    if (member.data && member.data.length > 0) {
                        result = await this.extractor.genericExtractor.save(member.data, outPathPrefix + ".dat");
                    }
                    break;
            }

            // 4. Capture extraction results for metadata serialization
            if (result) {
                member.image = result.file || result.path; // Canonical property for frontend asset loading
                member.format = result.format;
                if (result.width) member.width = result.width;
                if (result.height) member.height = result.height;
            }

        } catch (e) {
            this.log('ERROR', `Extraction error for member ${member.id}: ${e.message}`);
        }
    }

    /**
     * Explicit processing for Palette members. 
     * Called during the first pass of DirectorExtractor to populate shared palettes.
     */
    async processPalette(member, map) {
        try {
            const id = map?.[Magic.CLUT] || map?.[Magic.CLUT.toLowerCase()] || member.id;
            const chunk = this.extractor.dirFile.getChunkById(id);
            if (!chunk) return;

            const data = await this.extractor.dirFile.getChunkData(chunk);
            if (data) {
                member.palette = Palette.parseDirector(data);
                if (!this.extractor.defaultMoviePalette) {
                    this.extractor.defaultMoviePalette = member.palette;
                }
                const outPath = path.join(this.extractor.outputDir, `${member.name}.pal`);
                const result = await this.extractor.paletteExtractor.save(member.palette, outPath, member);
                if (result) member.format = result.format;
            }
        } catch (e) {
            this.log('ERROR', `Failed to process palette ${member.id}: ${e.message}`);
        }
    }
}

module.exports = MemberProcessor;
