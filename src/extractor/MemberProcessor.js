const fs = require('fs');
const path = require('path');
const Color = require('../utils/Color');
const { MemberType, Magic, AfterburnerTags } = require('../Constants');

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
    }

    async processBitmap(member, map) {
        const bitdId = map[Magic.BITD] || map[Magic.BITD.toLowerCase()] || map['DIB '] || map['DIB*'] || map['Abmp'] || map['PMBA'];
        if (!bitdId) {
            this.extractor.log('WARNING', `No BITD/DIB/Abmp/PMBA chunk found for bitmap member ${member.id} (${member.name}). Available tags: ${Object.keys(map).join(', ')}`);
            return;
        }

        let alphaBuf = null;
        if (map[Magic.ALFA]) {
            const alfa = await this.extractor.dirFile.getChunkData(this.extractor.dirFile.getChunkById(map[Magic.ALFA]));
            if (alfa) {
                const expected = (member.width || 1) * (member.height || 1);
                alphaBuf = (alfa.length < expected) ? this.extractor.bitmapExtractor.decompressPackBits(alfa, expected) : alfa;
            }
        }

        let palette = null;
        if (this.extractor.options.colored) {
            palette = this.resolvePalette(member);
        }

        const pixels = await this.extractor.dirFile.getChunkData(this.extractor.dirFile.getChunkById(bitdId));
        if (pixels) {
            this.extractor.log('INFO', `Extracting Bitmap: ${member.name} (${member.width}x${member.height})`);
            const outPath = path.join(this.extractor.outputDir, `${member.name}.png`);
            const res = await this.extractor.bitmapExtractor.extract(pixels, outPath, member, palette, alphaBuf);
            if (res) {
                member.image = path.basename(res.path);
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
                member.textFile = res.file;
                member.format = res.format;
            }
        }
    }

    resolvePalette(member) {
        let palette = null;
        let paletteSource = "unknown";
        const platform = this.extractor.metadata.movie?.platform || 'Macintosh';

        // 1. Internal Palettes (Same cast)
        const internalPal = this.extractor.members.find(m => m.id === member.paletteId && m.typeId === MemberType.Palette);
        if (internalPal?.palette) {
            palette = internalPal.palette;
            paletteSource = "internal";
            member.palette = { id: internalPal.id, name: internalPal.name, castlib: "internal" };
        }

        // 2. Project Context (Main movie or discovered casts)
        if (!palette && this.extractor.options.projectContext) {
            const globalEntry = this.extractor.options.projectContext.globalPalettes.find(p => p.id === member.paletteId || p.id === String(member.paletteId));
            if (globalEntry) {
                palette = globalEntry.colors;
                paletteSource = "project";
                member.palette = { id: globalEntry.id, name: globalEntry.name, castlib: globalEntry.source ? path.parse(globalEntry.source).name : "unknown" };
            }
        }

        // 3. Shared Palettes (shared_palettes.json)
        if (!palette && (this.extractor.sharedPalettes[member.paletteId] || this.extractor.sharedPalettes[String(member.paletteId)])) {
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

                // Get human readable name from Color class if available
                const paletteName = Color.getSystemPaletteName(member.paletteId) || (platform === 'Windows' ? "SystemWin" : "SystemMac");

                member.palette = {
                    id: member.paletteId,
                    name: paletteName,
                    castlib: "system"
                };
            }
        }

        // 5. Absolute Fallback
        if (!palette) {
            palette = (platform === 'Windows') ? Color.getWindowsSystem() : Color.getMacSystem7();
            paletteSource = "fallback_platform";
            member.palette = {
                id: member.paletteId || (platform === 'Windows' ? -101 : -1),
                name: (platform === 'Windows') ? "SystemWin" : "SystemMac",
                castlib: "system"
            };
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
                member.soundFile = res.file;
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
                member.fontFile = res.file;
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
            member.shapeFile = res.file;
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
                member.xtraFile = res.file;
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
                member.vectorFile = res.file;
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
                member.filmLoopFile = res.file;
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
