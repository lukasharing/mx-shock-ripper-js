const fs = require('fs');
const path = require('path');
const { Color } = require('../utils/Color');
const { MemberType, Magic, AfterburnerTags } = require('../Constants');
const { BitmapTags } = require('../constants/Bitmap');

/**
 * @version 1.3.0
 * MemberProcessor.js - Centralized orchestration for member-specific extraction logic.
 */
class MemberProcessor {
    constructor(extractor) {
        this.extractor = extractor;
    }

    async processMemberContent(member, chunk) {
        const map = this.extractor.metadataManager.keyTable[member.id];

        switch (member.typeId) {
            case MemberType.Bitmap:
                if (!map) return;
                if (this.extractor.options.extractBitmap) await this.processBitmap(member, map);
                break;
            case MemberType.Script:
                if (this.extractor.options.extractScript) await this.extractor.scriptHandler.handleScripts(member, map);
                break;
            case MemberType.Sound:
                if (!map) return;
                if (this.extractor.options.extractSound) await this.processSound(member, map);
                break;
            case MemberType.Font:
                if (!map) return;
                if (this.extractor.options.extractFont) await this.processFont(member, map);
                break;
            case MemberType.Shape:
                if (!map) return;
                if (this.extractor.options.extractShape) await this.processShape(member, map);
                break;
            case MemberType.Xtra:
                if (!map) return;
                if (this.extractor.options.extractXtra) await this.processXtra(member, map);
                break;
            // Text and Field are strictly content, no scripts.
            case MemberType.Text:
            case MemberType.Field:
                if (!map) return;
                if (this.extractor.options.extractText || this.extractor.options.extractField) {
                    await this.processText(member, map);
                }
                break;
            case MemberType.VectorShape:
                if (!map) return;
                if (this.extractor.options.extractVectorShape) await this.processVectorShape(member, map);
                break;
            case MemberType.FilmLoop:
                if (!map) return;
                if (this.extractor.options.extractFilmLoop) await this.processFilmLoop(member, map);
                break;
            case MemberType.Palette:
                // Palettes are processed separately in the main loop to ensure they are ready for bitmaps
                break;
            default:
                if ([MemberType.Bitmap_53, MemberType.Unknown_121, MemberType.Unknown_638, MemberType.Unknown_2049].includes(member.typeId)) {
                    if (!map) return;
                    await this.processUnknown(member, map);
                }
                break;
        }

        // Process scripts for any member that might have one (unless it's a Palette or Script which is handled above)
        if (member.typeId !== MemberType.Palette && member.typeId !== MemberType.Script && this.extractor.options.extractScript) {
            await this.extractor.scriptHandler.handleScripts(member, map);
        }
    }

    async processBitmap(member, map) {
        const possibleTags = BitmapTags.map(tag => Magic[tag] || tag);
        let pixels = null;
        let selectedTag = null;
        const endianness = member.endianness || this.extractor.dirFile.ds.endianness;

        for (const tag of possibleTags) {
            const id = map[tag];
            if (!id) continue;

            const chunk = this.extractor.dirFile.getChunkById(id);
            if (!chunk) continue;

            const data = await this.extractor.dirFile.getChunkData(chunk);
            if (data && data.length > (pixels ? pixels.length : 0)) {
                pixels = data;
                selectedTag = tag;
            }
        }

        if (!pixels) {
            this.extractor.log('WARNING', `No valid pixel data found for bitmap member ${member.id} (${member.name}). Available tags: ${Object.keys(map).join(', ')}`);
            return;
        }

        let alphaBuf = null;
        if (map[Magic.ALFA]) {
            const alfa = await this.extractor.dirFile.getChunkData(this.extractor.dirFile.getChunkById(map[Magic.ALFA]));
            if (alfa && alfa.length > 0) {
                const expected = (member.width || 1) * (member.height || 1);
                // Only decompress if it looks compressed (smaller than raw size), 
                // but verify content existence first.
                alphaBuf = (alfa.length < expected) ? this.extractor.bitmapExtractor.decompressPackBits(alfa, expected) : alfa;

                // Double check result
                if (alphaBuf && alphaBuf.length === 0) alphaBuf = null;
            }
        }

        let palette = null;
        if (this.extractor.options.colored) {
            palette = this.resolvePalette(member);
        }

        if (pixels) {
            this.extractor.log('INFO', `Extracting Bitmap: ${member.name} (${member.width}x${member.height})`);
            const outPath = path.join(this.extractor.outputDir, `${member.name}.png`);
            const res = await this.extractor.bitmapExtractor.extract(pixels, outPath, member, palette, alphaBuf);
            if (res) {
                member.format = res.format;
            }
        }
    }

    async processText(member, map) {
        const textId = map[Magic.STXT] || map[Magic.TEXT] || map['STXT'] || map['TEXT'];
        if (!textId) return;

        const data = await this.extractor.dirFile.getChunkData(this.extractor.dirFile.getChunkById(textId));
        if (data) {
            this.extractor.log('INFO', `Extracting Text: ${member.name}`);
            const outPath = path.join(this.extractor.outputDir, member.name);
            const res = this.extractor.textExtractor.save(data, outPath, member);
            if (res && res.file) {
                member.format = res.format;
            }
        }
    }

    resolvePalette(member) {
        let palette = null;
        let paletteSource = "unknown";
        const platform = this.extractor.metadata.movie?.platform || 'Macintosh';

        // 0. Skip palette resolution for true-color bitmaps (16-bit, 24-bit, 32-bit)
        if (member.bitDepth && member.bitDepth >= 16) {
            // True-color bitmaps don't use palettes - they store RGB values directly
            member.palette = { id: 0, name: "TrueColor", castlib: "builtin" };
            return null; // No palette needed
        }

        // 1. Resolve External Cast Context (if available)
        let targetCastName = "internal";
        if (member.castLibId > 1 && member.castLibId < 1000 && this.extractor.metadata.castList) {
            // castLibId is 1-based index into the CastList table.
            const castEntry = this.extractor.metadata.castList[member.castLibId - 1];
            if (castEntry) {
                targetCastName = castEntry.name;
            } else {
                // Cast lookup failed
            }
        }

        // 2. Internal Palettes (Same cast / CastLib 1)
        if (targetCastName === "internal") {
            const internalPal = this.extractor.members.find(m => m.id === member.paletteId && m.typeId === MemberType.Palette);
            if (internalPal?.palette) {
                palette = internalPal.palette;
                paletteSource = "internal";
                member.palette = { id: internalPal.id, name: internalPal.name, castlib: "internal" };
            }
        }

        // 2. Project Context (Cross-Cast Resolution)
        if (!palette && this.extractor.options.projectContext) {
            // Heuristic: If we know the target cast info, prioritize looking for palettes belonging to that cast.
            if (targetCastName !== "internal") {
                const globalEntry = this.extractor.options.projectContext.globalPalettes.find(p =>
                    (p.id === member.paletteId || p.id === String(member.paletteId)) &&
                    (p.source && path.parse(p.source).name.toLowerCase() === targetCastName.toLowerCase())
                );

                if (globalEntry) {
                    palette = globalEntry.colors;
                    paletteSource = "project_exact";
                    member.palette = { id: globalEntry.id, name: globalEntry.name, castlib: targetCastName };
                } else {
                    // If check fails, we still inform valid link, just missing data
                    member.palette = { id: member.paletteId, name: `Missing_Palette_${member.paletteId}`, castlib: targetCastName };
                    // We DO NOT fallback to system if we know it belongs to an external cast!
                    // Returning null palette here implies "custom palette missing", which renders as RED/Warning in UI?
                    // Or keep fallback to system just so it displays *something*?
                    // Better to fallback to System/Grayscale but KEEP the metadata pointing to external.
                }
            } else {
                // Legacy Heuristic for unmapped/internal-but-global lookups
                const isSmallId = (member.paletteId > 0 && member.paletteId <= 100);
                if (!isSmallId) {
                    const globalEntry = this.extractor.options.projectContext.globalPalettes.find(p => p.id === member.paletteId || p.id === String(member.paletteId));
                    if (globalEntry) {
                        palette = globalEntry.colors;
                        paletteSource = "project_heuristic";
                        member.palette = { id: globalEntry.id, name: globalEntry.name, castlib: globalEntry.source ? path.parse(globalEntry.source).name : "unknown" };
                    }
                }
            }
        }

        // 3. Shared Palettes (shared_palettes.json)
        // If we still haven't found it, and it wasn't strictly external (or external lookup failed)
        if (!palette && !member.palette?.castlib && (this.extractor.sharedPalettes[member.paletteId] || this.extractor.sharedPalettes[String(member.paletteId)])) {
            const shared = this.extractor.sharedPalettes[member.paletteId] || this.extractor.sharedPalettes[String(member.paletteId)];
            palette = shared.colors || shared;
            paletteSource = "shared_json";
            member.palette = { id: member.paletteId, name: shared.name || `shared_${member.paletteId}`, castlib: "shared" };
        }

        // 4. Standard System Palettes & Defaults
        if (!palette) {
            const sysPalette = Color.getSystemPaletteById(member.paletteId, platform);
            if (sysPalette) {
                palette = sysPalette;
                paletteSource = "system_id";
                const paletteName = Color.getSystemPaletteName(member.paletteId) || (platform === 'Windows' ? "SystemWin" : "SystemMac");
                // Only overwrite if we didn't establish a better link (e.g. external missing)
                if (!member.palette || member.palette.castlib === "system" || member.palette.castlib === "unknown") {
                    member.palette = {
                        id: member.paletteId,
                        name: paletteName,
                        castlib: "system"
                    };
                }
            }
        }

        // 5. Absolute Fallback
        if (!palette) {
            palette = (platform === 'Windows') ? Color.getWindowsSystem() : Color.getMacSystem7();
            paletteSource = "fallback_platform";
            if (!member.palette) {
                member.palette = {
                    id: member.paletteId || (platform === 'Windows' ? -101 : -1),
                    name: (platform === 'Windows') ? "SystemWin" : "SystemMac",
                    castlib: "system"
                };
            }
        }

        return palette;
    }

    async processPalette(member, map) {
        const id = map?.[Magic.CLUT] || map?.[Magic.CLUT.toLowerCase()] || member.id;
        const data = await this.extractor.dirFile.getChunkData(this.extractor.dirFile.getChunkById(id));
        if (data) {
            member.palette = Color.parseDirector(data);
            if (!this.extractor.defaultMoviePalette) {
                this.extractor.defaultMoviePalette = member.palette;

            }
            const outPath = path.join(this.extractor.outputDir, `${member.name}.pal`);
            this.extractor.paletteExtractor.save(member.palette, outPath, member);
            member.format = 'pal';
        }
    }

    async processSound(member, map) {
        const sndId = map[Magic.SND] || map[Magic.SND.toLowerCase()] || map[Magic.snd] || map['SND*'] || map['snd '];
        if (!sndId) return;
        const data = await this.extractor.dirFile.getChunkData(this.extractor.dirFile.getChunkById(sndId));
        if (data) {
            const outPath = path.join(this.extractor.outputDir, member.name);
            const res = this.extractor.soundExtractor.save(data, outPath, member);
            if (res && res.file) {
                member.format = res.format;
            }
        }
    }

    async processFont(member, map) {
        const fontId = map[Magic.VWFT] || map[Magic.FONT] || map['VWFT'] || map['FONT'];
        if (!fontId) return;
        const data = await this.extractor.dirFile.getChunkData(this.extractor.dirFile.getChunkById(fontId));
        if (data) {
            const outPath = path.join(this.extractor.outputDir, member.name);
            const res = this.extractor.fontExtractor.save(data, outPath);
            if (res && res.file) {
                member.format = res.format;
            }
        }
    }

    async processShape(member, map) {
        let palette = this.resolvePalette(member) || Color.getMacSystem7();
        this.extractor.log('INFO', `Extracting Shape: ${member.name}`);
        const outPath = path.join(this.extractor.outputDir, member.name);
        const res = this.extractor.shapeExtractor.save(outPath, member, palette);
        if (res && res.file) {
            member.format = res.format;
        }
    }

    async processXtra(member, map) {
        const xtraId = map[Magic.XTRA] || map[Magic.XTRA.toLowerCase()] || map[Magic.XTRA.toUpperCase()];
        if (!xtraId) return;
        const data = await this.extractor.dirFile.getChunkData(this.extractor.dirFile.getChunkById(xtraId));
        if (data) {
            const outPath = path.join(this.extractor.outputDir, `${member.name}.xtra`);
            const res = this.extractor.genericExtractor.save(data, outPath);
            if (res && res.file) {
                member.format = 'xtra';
            }
        }
    }

    async processVectorShape(member, map) {
        let dataId = 0;
        if (map) {
            const keys = Object.keys(map);
            const dataKey = keys.find(k => !['CASt', 'KEY*', 'Lscr'].includes(k));
            if (dataKey) dataId = map[dataKey];
        }
        if (!dataId) return;
        const data = await this.extractor.dirFile.getChunkData(this.extractor.dirFile.getChunkById(dataId));
        if (data) {
            const outPath = path.join(this.extractor.outputDir, member.name);
            const res = this.extractor.vectorShapeExtractor.save(data, outPath, member);
            if (res && res.file) {
                member.format = res.format;
            }
        }
    }

    async processFilmLoop(member, map) {
        let dataId = 0;
        if (map) dataId = map[Magic.SCORE] || map[Magic.VWSC] || map['Score'] || map['VWSC'];
        if (!dataId) return;
        const data = await this.extractor.dirFile.getChunkData(this.extractor.dirFile.getChunkById(dataId));
        if (data) {
            const outPath = path.join(this.extractor.outputDir, member.name);
            const res = this.extractor.movieExtractor.save(data, outPath, member);
            if (res && res.file) {
                member.format = res.format;
            }
        }
    }

    async processUnknown(member, map) {
        this.extractor.log('WARNING', `Processing Unknown Member ID ${member.id} (Type: ${member.typeId})...`);
        if (!map) return;
        const keys = Object.keys(map);
        for (const tag of keys) {
            const chunkId = map[tag];
            const data = await this.extractor.dirFile.getChunkData(this.extractor.dirFile.getChunkById(chunkId));
            if (data) {
                const dumpPath = path.join(this.extractor.outputDir, `unknown_${member.typeId}_${member.id}_${tag.replace(/[^a-zA-Z0-9]/g, '_')}.hex`);
                const binPath = path.join(this.extractor.outputDir, `unknown_${member.typeId}_${member.id}_${tag.replace(/[^a-zA-Z0-9]/g, '_')}.bin`);
                fs.writeFileSync(dumpPath, data.toString('hex'));
                fs.writeFileSync(binPath, data);
            }
        }
    }
}

module.exports = MemberProcessor;
