/**
 * @version 1.1.5
 * DirectorExtractor.js - Strategic extraction orchestrator for Adobe Director assets
 * 
 * This class coordinates the high-level extraction workflow, managing 
 * resource mapping (KeyTable), metadata extraction (CASt), and delegating 
 * content processing to specialized extractors (Bitmap, Sound, Lingo, etc.).
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Color = require('./utils/Color');
const DirectorFile = require('./DirectorFile');
const CastMember = require('./CastMember');
const DataStream = require('./utils/DataStream');
const { MemberType, Magic, AfterburnerTags, KeyTableValues, Resources, LingoConfig } = require('./Constants');

// Component Extractors
const BitmapExtractor = require('./member/BitmapExtractor');
const TextExtractor = require('./member/TextExtractor');
const PaletteExtractor = require('./member/PaletteExtractor');
const ScriptExtractor = require('./member/ScriptExtractor');
const SoundExtractor = require('./member/SoundExtractor');
const ShapeExtractor = require('./member/ShapeExtractor');
const FontExtractor = require('./member/FontExtractor');
const GenericExtractor = require('./member/GenericExtractor');
const LingoDecompiler = require('./lingo/LingoDecompiler');
const LnamParser = require('./lingo/LnamParser');

class DirectorExtractor {
    /**
     * @param {string} inputPath - Path to the source file (.dcr, .cct, .dir)
     * @param {string} outputDir - Directory to store extracted assets
     * @param {object} options - Configuration for extraction filters and processing
     */
    constructor(inputPath, outputDir, options = {}) {
        this.inputPath = inputPath;
        this.baseName = path.parse(inputPath).name;

        // Default extraction settings
        this.options = {
            extractBitmap: options.bitmap ?? true,
            extractFont: options.font ?? true,
            extractScript: options.script ?? true,
            extractSound: options.sound ?? true,
            extractPalette: options.palette ?? true,
            extractShape: options.shape ?? true,
            extractXtra: options.xtra ?? true,
            extractText: options.text ?? true,
            extractField: options.field ?? true,
            colored: options.colored ?? false
        };

        this.outputDir = outputDir || path.join(process.cwd(), 'extractions', this.baseName);
        this.keyTable = {};
        this.resToMember = {};
        this.members = [];
        this.extractionLog = [];
        this.stats = { total: 0, byType: {}, protectedScripts: 0, paletteRefs: { global: 0, relative: 0 } };

        this.metadata = {
            fileName: path.basename(inputPath),
            project: this.baseName,
            timestamp: new Date().toISOString(),
            members: []
        };

        // Internal Helpers
        const logProxy = (lvl, msg) => this.log(lvl, msg);
        this.textExtractor = new TextExtractor(logProxy);
        this.bitmapExtractor = new BitmapExtractor(logProxy, Color, 0);
        this.paletteExtractor = new PaletteExtractor(logProxy);
        this.scriptExtractor = new ScriptExtractor(logProxy);
        this.soundExtractor = new SoundExtractor(logProxy);
        this.shapeExtractor = new ShapeExtractor(logProxy);
        this.fontExtractor = new FontExtractor(logProxy);
        this.genericExtractor = new GenericExtractor(logProxy);
        this.lingoDecompiler = new LingoDecompiler(logProxy);
        this.lnamParser = new LnamParser(logProxy);

        this.nameTable = {};
        this.lctxMap = {};
        this.sharedPalettes = {};
    }

    /**
     * Entry point for the extraction process.
     */
    async extract() {
        this.log('INFO', `Starting extraction: ${this.metadata.fileName}`);

        // Auto-load project shared palettes if they exist in the neighborhood
        const sharedJson = path.join(path.dirname(this.inputPath), 'shared_palettes.json');
        if (fs.existsSync(sharedJson)) await this.loadSharedPalettes(sharedJson);

        const buffer = fs.readFileSync(this.inputPath);
        this.dirFile = new DirectorFile(buffer, (lvl, msg) => this.log(lvl, msg));
        await this.dirFile.parse();

        // 1. Initial Mapping & Metadata Extraction
        await this.parseKeyTable();
        await this.parseNameTable();
        await this.parseLctxMap();

        // 2. Extract Config & Context
        await this.extractConfig();
        await this.extractTimeline();
        await this.extractCastList();

        if (!fs.existsSync(this.outputDir)) fs.mkdirSync(this.outputDir, { recursive: true });

        // Pass 1: Extract Member Metadata
        const processingQueue = [];
        for (const chunk of this.dirFile.chunks) {
            const upType = chunk.type.toUpperCase();
            if ([Magic.CAST.toUpperCase(), AfterburnerTags['CAS*'].toUpperCase(), Magic.CAST_SPACE.toUpperCase()].includes(upType)) {
                try {
                    const member = await this.parseMemberMetadata(chunk);
                    if (member) processingQueue.push({ member, chunk });
                } catch (e) {
                    this.log('ERROR', `Metadata failure for chunk ${chunk.id}: ${e.message}`);
                }
            }
        }

        // Pass 2: Extract Content (Palettes first to ensure bitmap coloring)
        for (const item of processingQueue) {
            if (item.member.typeId === MemberType.Palette && this.options.extractPalette) {
                await this.processPalette(item.member, this.keyTable[item.member.id]);
            }
        }

        for (const item of processingQueue) {
            if (item.member.typeId !== MemberType.Palette) {
                await this.processMemberContent(item.member, item.chunk);
            }
        }

        // 2. Post-Processing: Lingo Bytecode Matching
        await this.matchDanglingScripts();

        // 3. Finalization
        this.metadata.members = this.members.map(m => m.toJSON());

        this.log('INFO', `===== EXTRACTION SUMMARY =====`);
        this.log('INFO', `Total Members: ${this.members.length}`);
        this.log('INFO', `Scripts: ${this.stats.byType['Script'] || 0}`);
        if (this.stats.protectedScripts > 0) this.log('INFO', `Protected Scripts: ${this.stats.protectedScripts}`);
        this.log('INFO', `Bitmaps: ${this.stats.byType['Bitmap'] || 0}`);
        this.log('INFO', `==============================`);

        this.saveJSON();
        this.saveLog();
        this.log('SUCCESS', `Extraction complete. Processed ${this.stats.total} members.`);
    }

    async extractConfig() {
        const configTags = [Magic.VWSC, Magic.VWCF, Magic.conf, Magic.VWky, Magic.DRCF];
        const chunk = this.dirFile.chunks.find(c => configTags.includes(c.type));
        if (!chunk) return;

        const isMovie = [Magic.MV93, Magic.MVPV].includes(this.dirFile.subtype) ||
            this.dirFile.chunks.some(c => [Magic.VWSC, Magic.SCORE, Magic.MCsL, Magic.Lscl].includes(c.type));

        if (!isMovie) return;

        const data = await this.dirFile.getChunkData(chunk);
        if (!data) return;

        const ds = new DataStream(data, 'big');
        ds.readInt16(); // len
        const fileVer = ds.readInt16();
        const stage = { top: ds.readInt16(), left: ds.readInt16(), bottom: ds.readInt16(), right: ds.readInt16() };

        ds.readInt16(); // minMember
        ds.readInt16(); // maxMember
        ds.seek(Offsets.DirConfig.DirectorVersion);
        const dirVer = ds.readInt16();

        ds.seek(Offsets.DirConfig.FrameRate);
        const frameRate = ds.readInt16();
        const platform = ds.readInt16();
        const protection = ds.readInt16();

        this.metadata.movie = {
            fileVersion: fileVer,
            directorVersion: dirVer,
            stageRect: stage,
            frameRate,
            platform,
            protection,
            humanVersion: this.humanVersion(dirVer)
        };
        fs.writeFileSync(path.join(this.outputDir, 'movie.json'), JSON.stringify(this.metadata.movie, null, 2));
    }

    humanVersion(ver) {
        return ver; // Logic can be expanded based on Director version mapping
    }

    async extractTimeline() {
        const scoreChunk = this.dirFile.chunks.find(c => c.type === Magic.VWSC || c.type === Magic.SCORE);
        if (!scoreChunk) return;

        const timeline = {
            hasScore: true,
            chunks: [{
                id: scoreChunk.id,
                type: scoreChunk.type,
                size: scoreChunk.len,
                note: "Internal parsing not implemented"
            }]
        };
        fs.writeFileSync(path.join(this.outputDir, 'timeline.json'), JSON.stringify(timeline, null, 2));
    }

    async extractCastList() {
        const chunk = this.dirFile.chunks.find(c => c.type === Magic.MCsL || c.type === Magic.Lscl);
        if (!chunk) return;

        const data = await this.dirFile.getChunkData(chunk);
        if (!data) return;

        const castList = [];
        let pos = 0;
        // Robust scanner handling Name -> Path -> Gap structure.
        while (pos < data.length - 2) {
            const len = data.readUInt16BE(pos);
            if (len > 0 && len < 256 && (pos + 2 + len + 2) < data.length) {
                let valid = true;
                for (let k = 0; k < len; k++) {
                    const b = data[pos + 2 + k];
                    if (b < 32 || b > 126) { valid = false; break; }
                }

                if (valid) {
                    const name = data.slice(pos + 2, pos + 2 + len).toString();
                    let p2 = pos + 2 + len;
                    if (p2 + 2 < data.length) {
                        const len2 = data.readUInt16BE(p2);
                        if (len2 >= 0 && len2 < 512 && (p2 + 2 + len2 + 9) <= data.length) {
                            let valid2 = true;
                            if (len2 > 0) {
                                for (let k = 0; k < len2; k++) {
                                    const b = data[p2 + 2 + k];
                                    if (b < 32 || b > 126) { valid2 = false; break; }
                                }
                            }

                            if (valid2) {
                                const pathStr = data.slice(p2 + 2, p2 + 2 + len2).toString();
                                const gapStart = p2 + 2 + len2;
                                const preloadMode = data.readUInt16BE(gapStart);

                                if (name.length > 2 || pathStr.length > 2) {
                                    castList.push({ name, path: pathStr, preloadMode });
                                    pos = gapStart + 9;
                                    continue;
                                }
                            }
                        }
                    }
                }
            }
            pos++;
        }

        if (castList.length > 0) {
            fs.writeFileSync(path.join(this.outputDir, 'castlibs.json'), JSON.stringify({ casts: castList }, null, 2));
        }
    }

    /**
     * Maps physical chunk IDs to logical member IDs using the KEY table.
     */
    async parseKeyTable() {
        const keyChunk = this.dirFile.chunks.find(c => {
            const unprot = DirectorFile.unprotect(c.type).toUpperCase();
            return [Magic.KEY.toUpperCase(), Magic.KEY_SPACE.toUpperCase()].includes(unprot);
        });
        if (!keyChunk) return;

        const data = await this.dirFile.getChunkData(keyChunk);
        if (!data) return;

        const ds = new DataStream(data, this.dirFile.ds.endianness);

        // Detect KEY* header size and Endianness
        let firstWord = ds.readUint16();

        // Auto-detect endianness mismatch for KEY* chunk
        if (firstWord === KeyTableValues.EndianMismatch || firstWord > 255) {
            ds.endianness = ds.endianness === 'big' ? 'little' : 'big';
            ds.seek(0);
            firstWord = ds.readUint16();
        }

        let headerSize = KeyTableValues.HeaderStandard;
        let usedCount;

        if (firstWord === KeyTableValues.HeaderShort) {
            headerSize = KeyTableValues.HeaderShort;
            ds.readUint16(); // skip second 12
            ds.readUint32(); // entryCount placeholder
            usedCount = ds.readUint32();
        } else {
            // Standard 20-byte header (e.g. Director 8+)
            ds.seek(12);
            ds.readUint32(); // entryCount placeholder
            usedCount = ds.readUint32();
        }

        ds.seek(headerSize);
        while (ds.position + 12 <= data.length) {
            const sectionID = ds.readInt32();
            const castID = ds.readInt32();
            const tag = ds.readFourCC();

            if (!this.keyTable[castID]) this.keyTable[castID] = {};
            this.keyTable[castID][tag] = sectionID;
            this.resToMember[sectionID] = castID;
        }

        // Parse LctX (ScriptContextChunk) properly to finding script mappings
        const lctxMap = {}; // ScriptID -> Lscr Chunk ID
        const lctxChunks = this.dirFile.chunks.filter(c => {
            const unprot = DirectorFile.unprotect(c.type).toUpperCase();
            return unprot === Magic.LCTX.toUpperCase() || unprot === AfterburnerTags.XtcL.toUpperCase();
        });

        for (const chunk of lctxChunks) {
            const data = await this.dirFile.getChunkData(chunk);
            if (!data || data.length < 18) continue;

            const ds = new DataStream(data, 'big');
            ds.skip(8); // unk0, unk1
            const entryCount = ds.readUint32();
            ds.readUint32(); // entryCount2
            const entriesOffset = ds.readUint16();

            if (entriesOffset < data.length) {
                ds.seek(entriesOffset);
                for (let i = 1; i <= entryCount; i++) {
                    if (ds.position + 12 > data.length) break;
                    ds.readInt32(); // unk0
                    const sectionId = ds.readInt32();
                    ds.readUint16(); // unk1
                    ds.readUint16(); // unk2

                    if (sectionId > -1) {
                        lctxMap[i] = sectionId;
                    }
                }
            }
        }
        this.lctxMap = lctxMap;
    }

    async parseNameTable() {
        const lnam = this.dirFile.chunks.find(c => c.type === Magic.LNAM || c.type === AfterburnerTags.manL);
        if (lnam) {
            const data = await this.dirFile.getChunkData(lnam);
            if (data) this.nameTable = this.lnamParser.parse(data);
        }
    }

    async parseLctxMap() {
        const lctxChunks = this.dirFile.chunks.filter(c => {
            const unprot = DirectorFile.unprotect(c.type).toUpperCase();
            return unprot === Magic.LCTX.toUpperCase() || unprot === AfterburnerTags.XtcL.toUpperCase();
        });

        for (const chunk of lctxChunks) {
            const data = await this.dirFile.getChunkData(chunk);
            if (!data || data.length < 8) continue;

            const ds = new DataStream(data, this.dirFile.ds.endianness);
            ds.skip(8); // Skip header

            const scriptId = this.resToMember[chunk.id];
            if (scriptId) {
                this.lctxMap[scriptId] = chunk.id;
            }
        }
    }

    async parseMemberMetadata(chunk) {
        const data = await this.dirFile.getChunkData(chunk);
        if (!data) return null;

        const memberId = this.resToMember[chunk.id] || chunk.id;
        const member = CastMember.fromChunk(memberId, data, this.dirFile.ds.endianness);

        member.checksum = crypto.createHash('sha256').update(data).digest('hex');
        if (!member.name) member.name = `member_${memberId}`;
        member.name = member.name.replace(Resources.Regex.FilenameSanitize, '_').trim();

        const typeName = CastMember.getTypeName(member.typeId);
        this.stats.total++;
        this.stats.byType[typeName] = (this.stats.byType[typeName] || 0) + 1;

        this.members.push(member);
        return member;
    }

    async processMemberContent(member, chunk) {
        const map = this.keyTable[member.id];
        if (this.options.extractScript) await this.handleScripts(member, map);

        if (!map) return;

        switch (member.typeId) {
            case MemberType.Bitmap:
                if (this.options.extractBitmap) await this.processBitmap(member, map);
                break;
            case MemberType.Sound:
                if (this.options.extractSound) await this.processSound(member, map);
                break;
            case MemberType.Font:
                if (this.options.extractFont) await this.processFont(member, map);
                break;
            case MemberType.Shape:
                if (this.options.extractShape) await this.processShape(member, map);
                break;
            case MemberType.Xtra:
                if (this.options.extractXtra) await this.processXtra(member, map);
                break;
            case MemberType.Text:
                if (this.options.extractText) await this.handleScripts(member, map);
                break;
            case MemberType.Field:
                if (this.options.extractField) await this.handleScripts(member, map);
                break;
        }
    }

    async processBitmap(member, map) {
        const bitdId = map[Magic.BITD] || map[AfterburnerTags['DIB ']] || map[AfterburnerTags['DIB*']] || map[Magic.BITD.toLowerCase()] || map[AfterburnerTags['DIB '].toLowerCase()] || map[AfterburnerTags['DIB*'].toLowerCase()];
        if (!bitdId) return;

        let alphaBuf = null;
        if (map[Magic.ALFA]) {
            const alfa = await this.dirFile.getChunkData(this.dirFile.getChunkById(map[Magic.ALFA]));
            if (alfa) {
                const expected = (member.width || 1) * (member.height || 1);
                alphaBuf = (alfa.length < expected) ? this.bitmapExtractor.decompressPackBits(alfa, expected) : alfa;
            }
        }

        let palette = Color.getMacSystem7();
        if (this.options.colored) {
            if (member.paletteId === 0) palette = Color.getMacSystem7();
            else if (member.paletteId === -1) palette = Color.getWindowsSystem();
            else if (member.paletteId > 0) {
                // Resolved from global shared palettes or internal CLUTs
                const shared = this.sharedPalettes[member.paletteId] || this.sharedPalettes[String(member.paletteId)];
                if (shared) {
                    palette = shared.colors || shared;
                } else {
                    const foundPal = this.members.find(m => m.id === member.paletteId && m.typeId === MemberType.Palette);
                    if (foundPal?.palette) palette = foundPal.palette;
                }
            }
        }

        const pixels = await this.dirFile.getChunkData(this.dirFile.getChunkById(bitdId));
        if (pixels) {
            this.log('INFO', `Extracting Bitmap: ${member.name} (${member.width}x${member.height})`);
            const outPath = path.join(this.outputDir, `${member.name}.png`);
            const res = await this.bitmapExtractor.extract(pixels, outPath, member, palette, alphaBuf);
            if (res) member.image = path.basename(res.path);
        }
    }

    async processPalette(member, map) {
        const id = map?.[Magic.CLUT] || map?.[Magic.CLUT.toLowerCase()] || member.id;
        const data = await this.dirFile.getChunkData(this.dirFile.getChunkById(id));
        if (data) {
            member.palette = Color.parseDirector(data);
            const outPath = path.join(this.outputDir, `${member.name}.pal`);
            this.paletteExtractor.save(member.palette, outPath, member);
        }
    }

    async processSound(member, map) {
        const sndId = map[Magic.SND] || map[Magic.SND.toLowerCase()] || map[AfterburnerTags['SND*']] || map[AfterburnerTags['SND*'].toLowerCase()];
        if (!sndId) return;
        const data = await this.dirFile.getChunkData(this.dirFile.getChunkById(sndId));
        if (data) {
            const outPath = path.join(this.outputDir, member.name);
            this.soundExtractor.save(data, outPath, member);
        }
    }

    async processFont(member, map) {
        const fontId = map[Magic.VWFT] || map[Magic.FONT] || map[Magic.VWFT.toUpperCase()] || map[Magic.FONT.toUpperCase()] || map[Magic.VWFT.toLowerCase()] || map[Magic.FONT.toLowerCase()];
        if (!fontId) return;
        const data = await this.dirFile.getChunkData(this.dirFile.getChunkById(fontId));
        if (data) {
            const outPath = path.join(this.outputDir, member.name);
            this.fontExtractor.save(data, outPath);
        }
    }

    async processShape(member, map) {
        let palette = Color.getMacSystem7();
        if (member.paletteId > 0 && this.sharedPalettes[member.paletteId]) {
            palette = this.sharedPalettes[member.paletteId];
        }
        const outPath = path.join(this.outputDir, member.name);
        this.shapeExtractor.save(outPath, member, palette);
    }

    async processXtra(member, map) {
        const xtraId = map[Magic.XTRA] || map[Magic.XTRA.toLowerCase()] || map[Magic.XTRA.toUpperCase()];
        if (!xtraId) return;
        const data = await this.dirFile.getChunkData(this.dirFile.getChunkById(xtraId));
        if (data) {
            const outPath = path.join(this.outputDir, `${member.name}.xtra`);
            this.genericExtractor.save(data, outPath);
        }
    }

    async handleScripts(member, memberKey) {
        if (!this.options.extractScript) return;

        let text = member.scriptText;
        let source = null;

        const potentialKeys = [memberKey];
        if (member.scriptId > 0 && this.keyTable[member.scriptId]) potentialKeys.push(this.keyTable[member.scriptId]);

        if (!text) {
            for (const key of potentialKeys) {
                if (!key) continue;
                // Only look for STXT/TEXT initially
                const textId = key[Magic.STXT] || key[Magic.TEXT];
                if (!textId) continue;

                const chunk = this.dirFile.chunks.find(c => c.id === textId);
                if (!chunk) continue;

                const buf = await this.dirFile.getChunkData(chunk);
                if (buf) {
                    text = this.textExtractor.extract(buf);
                    source = chunk.type;
                    break;
                }
            }
        }

        if (text && text.trim()) {
            const isScript = member.typeId === MemberType.Script;
            const extension = isScript ? '.ls' : '';
            const outPath = path.join(this.outputDir, `${member.name}${extension}`);
            this.scriptExtractor.save(text, outPath, member);
            member.scriptFile = `${member.name}${extension}`;
        } else {
            // Priority 1: LctX Mapping (Deterministic)
            let lscrId = 0;
            if (member.id > 0 && this.lctxMap[member.id]) {
                lscrId = this.lctxMap[member.id];
                source = 'Lscr (LctX)';
            }

            // Priority 2: KeyTable (Resource Mapping)
            if (!lscrId) {
                for (const key of potentialKeys) {
                    if (!key) continue;
                    lscrId = key[Magic.LSCR] || key[AfterburnerTags.rcsL];
                    if (lscrId) {
                        source = 'Lscr (KeyTable)';
                        break;
                    }
                }
            }

            if (lscrId) {
                const chunk = this.dirFile.chunks.find(c => c.id === lscrId);
                const lscrData = chunk ? await this.dirFile.getChunkData(chunk) : null;

                if (lscrData) {
                    this.log('INFO', `Member ID ${member.id}: Decompiling Bytecode from ${source}...`);
                    const decompiled = this.lingoDecompiler.decompile(lscrData, this.nameTable);
                    if (decompiled && decompiled.text) {
                        const outPath = path.join(this.outputDir, `${member.name}.ls`);
                        fs.writeFileSync(outPath, decompiled.text);
                        member.scriptFile = `${member.name}.ls`;
                        if (decompiled.text.includes(LingoConfig.Labels.ProtectedScript)) this.stats.protectedScripts++;
                    }
                }
            }
        }
    }

    async matchDanglingScripts() {
        const scripts = this.members.filter(m => m.typeId === MemberType.Script && !m.scriptFile);
        const lscrChunks = this.dirFile.chunks.filter(c => c.type === Magic.LSCR && !this.resToMember[c.id]);

        if (scripts.length > 0 && lscrChunks.length > 0) {
            this.log('INFO', `Attempting to match ${scripts.length} dangling scripts...`);
            for (let i = 0; i < Math.min(scripts.length, lscrChunks.length); i++) {
                const data = await this.dirFile.getChunkData(lscrChunks[i]);
                if (!data) continue;

                const decompiled = this.lingoDecompiler.decompile(data, this.nameTable);
                if (decompiled?.text) {
                    const outPath = path.join(this.outputDir, `${scripts[i].name}.ls`);
                    fs.writeFileSync(outPath, decompiled.text);
                    scripts[i].scriptFile = `${scripts[i].name}.ls`;
                }
            }
        }
    }

    log(lvl, msg) {
        this.extractionLog.push({ timestamp: new Date().toISOString(), lvl, msg });
        const color = lvl === 'ERROR' ? '\x1b[31m' : (lvl === 'SUCCESS' ? '\x1b[32m' : '\x1b[0m');
        console.log(`${color}[${lvl}] ${msg}\x1b[0m`);
    }

    saveJSON() {
        fs.writeFileSync(path.join(this.outputDir, 'members.json'), JSON.stringify(this.metadata, null, 2));
    }

    saveLog() {
        const logContent = this.extractionLog.map(e => `[${e.timestamp}] ${e.lvl.padEnd(5)} ${e.msg}`).join('\n');
        fs.writeFileSync(path.join(this.outputDir, 'extraction.log'), logContent);
    }
}

module.exports = DirectorExtractor;
