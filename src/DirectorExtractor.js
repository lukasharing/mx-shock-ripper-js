/**
 * @version 1.2.0
 * DirectorExtractor.js - Strategic extraction orchestrator for Adobe Director assets
 * 
 * Coordinates the high-level extraction workflow, managing 
 * resource mapping (KeyTable) and delegating to specialized extractors.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Color = require('./utils/Color');
const DirectorFile = require('./DirectorFile');
const CastMember = require('./CastMember');
const DataStream = require('./utils/DataStream');
const { MemberType, Magic, AfterburnerTags, KeyTableValues, Resources, LingoConfig, Offsets } = require('./Constants');

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
const VectorShapeExtractor = require('./member/VectorShapeExtractor');
const MovieExtractor = require('./member/MovieExtractor');

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
            extractShape: options.shape ?? true,
            extractXtra: options.xtra ?? true,
            extractText: options.text ?? true,
            extractField: options.field ?? true,
            extractVectorShape: options.vectorShape ?? true,
            extractFilmLoop: options.filmLoop ?? true,
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
        this.genericExtractor = new GenericExtractor(logProxy);
        this.lingoDecompiler = new LingoDecompiler(logProxy);
        this.lnamParser = new LnamParser(logProxy);
        this.vectorShapeExtractor = new VectorShapeExtractor(logProxy);
        this.movieExtractor = new MovieExtractor(logProxy);

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

        if (!fs.existsSync(this.outputDir)) fs.mkdirSync(this.outputDir, { recursive: true });

        // 2. Extract Config & Context
        await this.extractConfig();
        await this.extractTimeline();
        await this.extractCastList();

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
        const configTags = [Magic.VWSC, Magic.VWCF, 'conf', 'VWky', Magic.DRCF];
        const chunk = this.dirFile.chunks.find(c => configTags.includes(c.type));
        if (!chunk) return;

        const isMovie = [Magic.MV93, Magic.MVPV].includes(this.dirFile.subtype) ||
            this.dirFile.chunks.some(c => [Magic.VWSC, Magic.SCORE, Magic.MCsL, Magic.Lscl].includes(c.type));

        if (!isMovie) return;

        const data = await this.dirFile.getChunkData(chunk);
        if (!data) return;

        const ds = new DataStream(data, 'big');
        const len = ds.readInt16();
        const fileVer = ds.readInt16();
        const stage = { top: ds.readInt16(), left: ds.readInt16(), bottom: ds.readInt16(), right: ds.readInt16() };

        const minMember = ds.readInt16();
        const maxMember = ds.readInt16();

        // Use humanVersion early to handle different versions
        ds.seek(36);
        const dirVer = ds.readInt16();
        const ver = this.humanVersion(dirVer);
        const verNum = parseInt(ver.replace(/\./g, '')) || 0; // e.g. 702

        // Stage Color logic
        let stageColor = "#FFFFFF";
        if (verNum < 700) {
            ds.seek(26);
            const paletteIdx = ds.readInt16();
            stageColor = `Palette Index ${paletteIdx}`;
        } else {
            ds.seek(18);
            const g = ds.readUint8();
            const b = ds.readUint8();
            ds.seek(26);
            const isRGB = ds.readUint8();
            const r = ds.readUint8();
            if (isRGB) {
                stageColor = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`.toUpperCase();
            } else {
                stageColor = `Palette Index ${r}`;
            }
        }

        ds.seek(28);
        const bitDepth = ds.readInt16();

        ds.seek(Offsets.DirConfig.FrameRate);
        const frameRate = ds.readInt16();
        const platformId = ds.readInt16();
        const protectionVal = ds.readInt16();

        const platformMap = {
            "-1": "Macintosh",
            "1024": "Windows"
        };
        const platform = platformMap[platformId] || `Unknown (${platformId})`;
        const protection = (protectionVal % 23 === 0) ? "Protected" : "None";

        this.metadata.movie = {
            fileVersion: fileVer,
            directorVersion: dirVer,
            humanVersion: ver,
            stageRect: stage,
            frameRate,
            bitDepth,
            stageColor,
            platform,
            protection,
            minMember,
            maxMember
        };
        this.bitmapExtractor.fileVersion = fileVer;
        fs.writeFileSync(path.join(this.outputDir, 'movie.json'), JSON.stringify(this.metadata.movie, null, 2));
    }

    humanVersion(ver) {
        return ver; // Logic can be expanded based on Director version mapping
    }

    async extractTimeline() {
        const scoreChunk = this.dirFile.chunks.find(c => c.type === Magic.VWSC || c.type === Magic.SCORE);
        if (!scoreChunk) return;

        const data = await this.dirFile.getChunkData(scoreChunk);
        if (!data) return;

        const timeline = {
            frameCount: 0,
            markers: [],
            scoreChunk: {
                id: scoreChunk.id,
                type: scoreChunk.type,
                size: data.length
            }
        };

        const ds = new DataStream(data, 'big');

        try {
            if (scoreChunk.type === Magic.VWSC) {
                // VWSC (Director 4 Score)
                // [2] sz, [2] ver, [4] numFrames, [4] labelsOffset, [4] something...
                ds.seek(4);
                timeline.frameCount = ds.readUint32();
                const labelsOffset = ds.readUint32();

                if (labelsOffset > 0 && labelsOffset < data.length) {
                    ds.seek(labelsOffset);
                    const labelCount = ds.readUint16();
                    for (let i = 0; i < labelCount; i++) {
                        if (ds.position + 3 > data.length) break;
                        const frame = ds.readUint16();
                        const nameLen = ds.readUint8();
                        const name = ds.readString(nameLen);
                        timeline.markers.push({ frame, name });
                    }
                }
            } else if (scoreChunk.type === Magic.SCORE) {
                // SCORE (Director 5+ Score)
                // Often has a similar structure or a secondary header.
                // For now, let's try to find labels by searching for the "labels" magic or expected layout.
                ds.seek(12);
                const labelsOffset = ds.readUint32();
                if (labelsOffset > 0 && labelsOffset < data.length) {
                    ds.seek(labelsOffset);
                    const labelCount = ds.readUint16();
                    for (let i = 0; i < labelCount; i++) {
                        if (ds.position + 3 > data.length) break;
                        const frame = ds.readUint16();
                        const nameLen = ds.readUint8();
                        const name = ds.readString(nameLen);
                        timeline.markers.push({ frame, name });
                    }
                }
            }
        } catch (e) {
            this.log('WARN', `Failed to parse timeline details: ${e.message}`);
        }

        fs.writeFileSync(path.join(this.outputDir, 'timeline.json'), JSON.stringify(timeline, null, 2));
    }

    async extractCastList() {
        const chunk = this.dirFile.chunks.find(c => c.type === Magic.MCsL || c.type === Magic.Lscl);
        if (!chunk) return;

        const data = await this.dirFile.getChunkData(chunk);
        if (!data) return;

        // Director ListChunks (like MCsL) have a structured format:
        // [4] dataOffset
        // [...] Other header fields
        // [at dataOffset]: [2] offsetTableCount, [4*count] offsetTable
        // [at end of offsetTable]: [4] itemsLength, [...] item data

        const ds = new DataStream(data, 'big');
        const dataOffset = ds.readUint32();
        ds.skip(2); // unk0
        const castCount = ds.readUint16();
        const itemsPerCast = ds.readUint16();

        if (castCount === 0 || itemsPerCast === 0) return;

        ds.seek(dataOffset);
        const offsetTableLen = ds.readUint16();
        const offsets = [];
        for (let i = 0; i < offsetTableLen; i++) {
            offsets.push(ds.readUint32());
        }

        const itemsLen = ds.readUint32();
        const itemsBase = ds.position;

        const readItem = (idx) => {
            if (idx >= offsets.length) return null;
            const start = offsets[idx];
            const end = (idx + 1 < offsets.length) ? offsets[idx + 1] : itemsLen;
            if (start >= end) return null;

            const itemData = data.slice(itemsBase + start, itemsBase + end);
            if (itemData.length === 0) return "";

            // Try as Pascal string first (common in ListChunks for names/paths)
            const len = itemData[0];
            if (len > 0 && len < itemData.length) {
                return itemData.slice(1, 1 + len).toString('utf8');
            }
            return itemData.toString('utf8').replace(/\0/g, '').trim();
        };

        const castList = [];
        const actualCastCount = Math.floor(offsetTableLen / itemsPerCast);

        const preloadMap = {
            0: "Never",
            1: "When Needed",
            2: "Before Frame 1",
            3: "After Frame 1"
        };

        for (let i = 0; i < actualCastCount; i++) {
            let name = readItem(i * itemsPerCast + 1) || "Unnamed Cast";
            let pathStr = readItem(i * itemsPerCast + 2) || "";

            // Preload settings are usually the 3rd item (index 3 in 1-based, index 2 in 0-based relative to cast start)
            let preloadMode = "When Needed";
            const preloadIdx = i * itemsPerCast + 3;
            if (preloadIdx < offsetTableLen) {
                const pData = data.slice(itemsBase + offsets[preloadIdx], itemsBase + (offsets[preloadIdx + 1] || itemsLen));
                if (pData.length >= 2) {
                    const modeVal = pData.readUInt16BE(0);
                    preloadMode = preloadMap[modeVal] || `Unknown (${modeVal})`;
                }
            }

            // Cleanup: If name is a path and path is empty, fix it
            if (name.includes('\\') || name.includes('/') || name.toLowerCase().endsWith('.cst') || name.toLowerCase().endsWith('.cct')) {
                if (!pathStr) pathStr = name;
                name = path.basename(name.replace(/\\/g, '/')).replace(/\.(cst|cct|dcr|dir)$/i, '');
            }

            if (pathStr && (pathStr.includes('\\') || pathStr.includes('/')) && !pathStr.toLowerCase().match(/\.(cst|cct|dcr|dir)$/)) {
                pathStr += '.cst';
            }

            if (name.toLowerCase() === 'internal') continue;

            castList.push({ name, path: pathStr, preloadMode });
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
            return unprot === 'KEY*' || unprot === 'KEY ';
        });
        if (!keyChunk) return;

        const data = await this.dirFile.getChunkData(keyChunk);
        if (!data) return;

        const ds = new DataStream(data, this.dirFile.ds.endianness);

        // Detect KEY* header size and Endianness
        let firstWord = ds.readUint16();

        if (firstWord === 0x4B45 || firstWord === 0x454B) { // KEY* in endian
            ds.seek(0);
            ds.readFourCC();
            firstWord = ds.readUint16();
        }

        // Auto-detect endianness mismatch for KEY* chunk
        if (firstWord > 255) {
            ds.endianness = ds.endianness === 'big' ? 'little' : 'big';
            ds.seek(2);
            firstWord = ds.readUint16();
        }

        let headerSize = 20;
        let usedCount;

        if (firstWord === 12) {
            headerSize = 12;
            ds.readUint16(); // skip second 12
            ds.readUint32(); // entryCount placeholder
            usedCount = ds.readUint32();
        } else {
            ds.seek(12);
            ds.readUint32(); // entryCount placeholder
            usedCount = ds.readUint32();
        }

        ds.seek(headerSize);
        for (let i = 0; i < usedCount; i++) {
            if (ds.position + 12 > data.length) break;
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
            return unprot === 'LCTX' || unprot === 'XTCL';
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
            case MemberType.Field:
                if (this.options.extractField) await this.handleScripts(member, map);
                break;
            case MemberType.VectorShape:
                if (this.options.extractVectorShape) await this.processVectorShape(member, map);
                break;
            case MemberType.FilmLoop:
                if (this.options.extractFilmLoop) await this.processFilmLoop(member, map);
                break;
            default:
                // Check if it's one of the unknown types we are researching
                if ([MemberType.Bitmap_53, MemberType.Unknown_121, MemberType.Unknown_638, MemberType.Unknown_2049].includes(member.typeId)) {
                    await this.processUnknown(member, map);
                }
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

        let palette = null;
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

    async processVectorShape(member, map) {
        let dataId = 0;
        if (map) {
            const keys = Object.keys(map);
            const dataKey = keys.find(k => !['CASt', 'KEY*', 'Lscr'].includes(k));
            if (dataKey) dataId = map[dataKey];
        }
        if (!dataId) return;

        const data = await this.dirFile.getChunkData(this.dirFile.getChunkById(dataId));
        if (data) {
            const outPath = path.join(this.outputDir, member.name);
            this.vectorShapeExtractor.save(data, outPath, member);
        }
    }

    async processFilmLoop(member, map) {
        let dataId = 0;
        if (map) {
            dataId = map[Magic.SCORE] || map[Magic.VWSC] || map['Score'] || map['VWSC'];
        }
        if (!dataId) return;

        const data = await this.dirFile.getChunkData(this.dirFile.getChunkById(dataId));
        if (data) {
            const outPath = path.join(this.outputDir, member.name);
            this.movieExtractor.save(data, outPath, member);
        }
    }

    async processUnknown(member, map) {
        this.log('WARNING', `Processing Unknown Member ID ${member.id} (Type: ${member.typeId})...`);

        if (!map) {
            this.log('WARNING', `No KeyTable entry for member ${member.id}. Cannot find content.`);
            return;
        }

        const keys = Object.keys(map);
        for (const tag of keys) {
            const chunkId = map[tag];
            const data = await this.dirFile.getChunkData(this.dirFile.getChunkById(chunkId));
            if (data) {
                this.log('INFO', `Dumping chunk ${tag} (${data.length} bytes) for unknown member.`);
                const hexDump = data.toString('hex');
                const dumpPath = path.join(this.outputDir, `unknown_${member.typeId}_${member.id}_${tag.replace(/[^a-zA-Z0-9]/g, '_')}.hex`);
                const binPath = path.join(this.outputDir, `unknown_${member.typeId}_${member.id}_${tag.replace(/[^a-zA-Z0-9]/g, '_')}.bin`);

                fs.writeFileSync(dumpPath, hexDump);
                fs.writeFileSync(binPath, data);
            }
        }
    }

    /**
     * Orchestrates script extraction for a member, handling both raw text (STXT) 
     * and decompiled bytecode (Lscr).
     */
    async handleScripts(member, memberKey) {
        if (!this.options.extractScript) return;

        // 1. Try to resolve source text (for Fields/Text members or scripts with source)
        const { text, source: textSource } = await this._resolveScriptText(member, memberKey);

        if (text && text.trim() && member.typeId !== MemberType.Script) {
            this.log('DEBUG', `Member ${member.name}: Saving script from ${textSource} chunk source.`);
            const outPath = path.join(this.outputDir, `${member.name}`);
            const res = this.scriptExtractor.save(text, outPath, member);
            if (res) {
                member.scriptFile = res.scriptFile;
                member.scriptLength = res.scriptLength;
                member.scriptSource = textSource;
            }
            return;
        }

        // 2. Try to resolve Lscr bytecode if no raw text was found or if it's a Script member
        const potentialKeys = [memberKey];
        if (member.scriptId > 0 && this.keyTable[member.scriptId]) potentialKeys.push(this.keyTable[member.scriptId]);

        const { lscrId, source: lscrSource } = this._resolveLscrChunk(member, potentialKeys);

        if (lscrId) {
            await this._decompileLscr(lscrId, lscrSource, member);
        } else if (member.typeId === MemberType.Script) {
            this.log('WARNING', `Member ID ${member.id} (Script): No script chunks found.`);
        }
    }

    /**
     * Attempts to find raw STXT or TEXT data for a member.
     */
    async _resolveScriptText(member, memberKey) {
        let text = member.scriptText;
        let source = text ? 'Member Metadata' : null;

        if (!text) {
            const potentialKeys = [memberKey];
            if (member.scriptId > 0 && this.keyTable[member.scriptId]) potentialKeys.push(this.keyTable[member.scriptId]);

            for (const key of potentialKeys) {
                if (!key) continue;
                const textId = key[Magic.STXT] || key[Magic.TEXT] || key['STXT'] || key['TEXT'];
                if (!textId) continue;

                const chunk = this.dirFile.getChunkById(textId);
                if (!chunk) continue;

                const buf = await this.dirFile.getChunkData(chunk);
                if (buf) {
                    text = this.textExtractor.extract(buf);
                    source = chunk.type;
                    break;
                }
            }
        }
        return { text, source };
    }

    /**
     * Identifies the Lscr chunk ID for a member using deterministic and heuristic mappings.
     */
    _resolveLscrChunk(member, potentialKeys) {
        let lscrId = 0;
        let source = null;

        // Priority 1: LctX Mapping (Deterministic)
        if (member.scriptId > 0 && this.lctxMap[member.scriptId]) {
            lscrId = this.lctxMap[member.scriptId];
            source = 'Lscr (LctX)';
        } else if (member.id > 0 && this.lctxMap[member.id]) {
            lscrId = this.lctxMap[member.id];
            source = 'Lscr (LctX)';
        }

        // Priority 2: KeyTable (Resource Mapping)
        if (!lscrId) {
            for (const key of potentialKeys) {
                if (!key) continue;
                lscrId = key[Magic.LSCR] || key[AfterburnerTags.rcsL] || key['Lscr'] || key['rcsL'];
                if (lscrId) {
                    source = 'Lscr (KeyTable)';
                    break;
                }
            }
        }

        // Priority 3: Fallback from pass 2 (Heuristic)
        if (!lscrId && member.scriptChunkId) {
            lscrId = member.scriptChunkId;
            source = 'Lscr (Heuristic)';
        }

        return { lscrId, source };
    }

    /**
     * Handles the actual decompilation of an Lscr chunk.
     */
    async _decompileLscr(lscrId, source, member) {
        const chunk = this.dirFile.getChunkById(lscrId);
        const lscrData = chunk ? await this.dirFile.getChunkData(chunk) : null;
        if (!lscrData) return;

        this.log('INFO', `Member ID ${member.id}: Decompiling Bytecode from ${source}...`);

        // --- Dynamic Lnam Selection ---
        let names = this.nameTable;
        if (chunk) {
            const idx = this.dirFile.chunks.indexOf(chunk);
            if (idx !== -1) {
                for (let i = idx; i >= 0; i--) {
                    const c = this.dirFile.chunks[i];
                    const type = c.type.toUpperCase();
                    if ([Magic.LNAM.toUpperCase(), AfterburnerTags.manL.toUpperCase()].includes(type)) {
                        try {
                            const lnamData = await this.dirFile.getChunkData(c);
                            const localNames = this.lnamParser.parse(lnamData);
                            if (localNames && Object.keys(localNames).length > 0) {
                                names = localNames;
                            }
                        } catch (e) {
                            this.log('WARNING', `Failed to parse Context Lnam ${c.id}: ${e.message}`);
                        }
                        break;
                    }
                }
            }
        }

        const decompiled = this.lingoDecompiler.decompile(lscrData, names, member.scriptType, member.id, { lasm: this.options.lasm });
        const decompiledText = (typeof decompiled === 'object') ? decompiled.text || decompiled.source : decompiled;

        if (decompiledText) {
            const outPath = path.join(this.outputDir, `${member.name}.ls`);
            fs.writeFileSync(outPath, decompiledText);
            member.scriptFile = `${member.name}.ls`;
            member.scriptSource = `${source} (Decompiled)`;
            member.scriptLength = decompiledText.length;

            if (this.options.lasm && decompiled.lasm) {
                const lasmPath = path.join(this.outputDir, `${member.name}.lasm`);
                fs.writeFileSync(lasmPath, decompiled.lasm);
                member.lasmFile = `${member.name}.lasm`;
            }

            if (decompiledText.includes(LingoConfig.Labels.ProtectedScript)) {
                this.stats.protectedScripts = (this.stats.protectedScripts || 0) + 1;
            }
        } else {
            this.log('WARNING', `Member ID ${member.id}: Decompilation failed. Saving raw bytecode.`);
            const lscPath = path.join(this.outputDir, `${member.name}.lsc`);
            this.genericExtractor.save(lscrData, lscPath, member);
            member.scriptFile = `${member.name}.lsc`;
            member.scriptSource = `${source} (Raw)`;
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
        fs.writeFileSync(path.join(this.outputDir, `${this.baseName}_extraction.log`), logContent);
    }
}

module.exports = DirectorExtractor;
