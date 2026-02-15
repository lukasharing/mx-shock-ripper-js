const path = require('path');
const fs = require('fs');
const { MemberType, Magic } = require('../Constants');
const { Palette } = require('../utils/Palette');
const { Color } = require('../utils/Color');

/**
 * @version 1.3.7
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
            if (member.typeId === MemberType.Bitmap) {
                // Bitmap processing logic below
            }

            const primaryTag = [
                Magic.BITD, Magic.DIB, Magic.PIXL, 'Pixl', 'bitd', 'Abmp', 'PMBA',
                Magic.STXT, Magic.TEXT, Magic.SND, Magic.FONT, Magic.VWFT,
                Magic.CLUT, Magic.CVWS, Magic.XTRA, Magic.SCORE, Magic.VWSC
            ].find(t => map && map[t]);

            if (primaryTag && map[primaryTag]) {
                const chunkId = map[primaryTag];
                const dataChunk = this.extractor.dirFile.getChunkById(chunkId);
                member.data = await this.extractor.dirFile.getChunkData(dataChunk);
            } else {
                // Fallback: If no explicit primary tag is found in the map, use the chunk passed from the CAST loop.
                member.data = await this.extractor.dirFile.getChunkData(chunk);
            }

            // Priority 2: Alpha Channel (ALFA) - specific to Bitmaps
            if (map && map[Magic.ALFA]) {
                member.alphaData = await this.extractor.dirFile.getChunkData(this.extractor.dirFile.getChunkById(map[Magic.ALFA]));
            }

            // Final delegation to extractor logic
            await this.processMember(member, map);

        } catch (e) {
            this.log('ERROR', `Failed to process member content for ${member.id} (${member.name}): ${e.message}`);
        }
    }

    /**
     * Specialized processing for a member once its data chunks are resolved.
     */
    async processMember(member, map) {
        try {
            if (!member || !member.id) return;

            // 1. Determine Output Path
            // Raw member name is preserved, but sanitized for filesystem safety.
            const baseName = member.name || `member_${member.id}`;
            const sanitizedName = baseName.replace(/[/\\?%*:|"<>]/g, '_');
            const outPathPrefix = path.join(this.extractor.outputDir, sanitizedName);

            // 2. Resolve Palette for Bitmaps & Shapes
            let finalPalette = null;
            // 2. Resolve Palette for Bitmaps & Shapes
            if (member.typeId === MemberType.Bitmap || member.typeId === MemberType.Shape) {
                finalPalette = await Palette.resolveMemberPalette(member, this.extractor);
            }

            // 3. Delegate to specialized extractors based on MemberType
            let result = null;

            this.log('DEBUG', `[MemberProcessor] Processing ${member.name} (ID: ${member.id}, typeId: ${member.typeId})`);

            const typeId = member.typeId;
            if (typeId === MemberType.Bitmap) {
                result = await this.extractor.bitmapExtractor.extract(member.data, outPathPrefix + ".png", member, finalPalette, member.alphaData);
            } else if (typeId === MemberType.Palette) {
                if (member.data) {
                    member.palette = Palette.parseDirector(member.data);
                    result = await this.extractor.paletteExtractor.save(member.palette, outPathPrefix + ".pal", member);
                }
            } else if (typeId === MemberType.Script) {
                result = await this.extractor.scriptHandler.handleScripts(member, map);
            } else if (typeId === MemberType.Sound) {
                result = await this.extractor.soundExtractor.save(member.data, outPathPrefix + ".wav", member);
            } else if (typeId === MemberType.Text || typeId === MemberType.Field) {
                const name = member.name || '';
                const hasExt = name.match(/\.(props|txt|json|xml|html|css|js|ls|lsc)$/i);
                const useRaw = !!hasExt;
                const ext = hasExt ? '' : '.rtf';
                result = await this.extractor.textExtractor.save(member.data, outPathPrefix + ext, member, { useRaw });
            } else if (typeId === MemberType.Shape) {
                result = await this.extractor.shapeExtractor.save(outPathPrefix + ".svg", member, finalPalette);
            } else if (typeId === MemberType.Font) {
                result = await this.extractor.fontExtractor.save(member.data, outPathPrefix + ".fnt");
            } else if (typeId === MemberType.VectorShape) {
                result = await this.extractor.vectorShapeExtractor.save(member.data, outPathPrefix + ".svg", member);
            } else if (typeId === MemberType.FilmLoop) {
                result = await this.extractor.movieExtractor.save(member.data, outPathPrefix + ".json", member);
            } else {
                if (member.data && member.data.length > 0) {
                    result = await this.extractor.genericExtractor.save(member.data, outPathPrefix + ".dat");
                }
            }

            // 4. Capture extraction results for metadata serialization
            if (result) {
                member.image = result.file || result.path; // Canonical property for frontend asset loading
                member.format = result.format;
                if (result.width) member.width = result.width;
                if (result.height) member.height = result.height;
                if (result.length) member.scriptLength = result.length;
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
            const id = map?.[Magic.CLUT] || map?.[Magic.CLUT.toLowerCase()] ||
                map?.['Palt'] || map?.['palt'] ||
                member.id;
            const chunk = this.extractor.dirFile.getChunkById(id);
            if (!chunk) {
                // this.log('WARN', `Palette chunk not found for member ${member.id} (Ref: ${id})`);
                return;
            }

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
