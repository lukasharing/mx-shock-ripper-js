/**
 * @version 1.1.0
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
const { MemberType, Magic, KeyTableValues, Resources, LingoConfig } = require('./Constants');

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
            colored: options.colored ?? false,
            ...options
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

        if (!fs.existsSync(this.outputDir)) fs.mkdirSync(this.outputDir, { recursive: true });

        // Pass 1: Extract Member Metadata
        const processingQueue = [];
        for (const chunk of this.dirFile.chunks) {
            if ([Magic.CAST, 'CAS*'].includes(chunk.type)) {
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
        this.saveResults();
        this.log('SUCCESS', `Extraction complete. Processed ${this.stats.total} members.`);
    }

    /**
     * Maps physical chunk IDs to logical member IDs using the KEY table.
     */
    async parseKeyTable() {
        const keyChunk = this.dirFile.chunks.find(c => [Magic.KEY, 'KEY '].includes(c.type));
        if (!keyChunk) return;

        const data = await this.dirFile.getChunkData(keyChunk);
        if (!data) return;

        const ds = new DataStream(data, this.dirFile.ds.endianness);
        let firstWord = ds.readUint16();

        if (firstWord === KeyTableValues.EndianMismatch) {
            ds.endianness = ds.endianness === 'big' ? 'little' : 'big';
            ds.seek(0);
            firstWord = ds.readUint16();
        }

        const headerSize = (firstWord === KeyTableValues.HeaderShort) ? 12 : 20;
        ds.seek(headerSize === 12 ? 8 : 16);
        const usedCount = ds.readUint32();
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
    }

    async parseNameTable() {
        const lnam = this.dirFile.chunks.find(c => c.type === Magic.LNAM || c.type === 'manL');
        if (lnam) {
            const data = await this.dirFile.getChunkData(lnam);
            if (data) this.nameTable = this.lnamParser.parse(data);
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
        const bitdId = map[Magic.BITD] || map['DIB '] || map['DIB*'];
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
                const shared = this.sharedPalettes[member.paletteId];
                if (shared) palette = shared;
                else if (this.members.find(m => m.id === member.paletteId)?.palette) {
                    palette = this.members.find(m => m.id === member.paletteId).palette;
                }
            }
        }

        const pixels = await this.dirFile.getChunkData(this.dirFile.getChunkById(bitdId));
        if (pixels) {
            const outPath = path.join(this.outputDir, `${member.name}.png`);
            await this.bitmapExtractor.extract(pixels, outPath, member, palette, alphaBuf);
        }
    }

    async processPalette(member, map) {
        const id = map?.[Magic.CLUT] || map?.[Magic.CLUT.toLowerCase()] || member.id;
        const data = await this.dirFile.getChunkData(this.dirFile.getChunkById(id));
        if (data) {
            member.palette = Color.parseDirector(data);
            const outPath = path.join(this.outputDir, `${member.name}.json`);
            this.paletteExtractor.save(member.palette, outPath, member);
        }
    }

    async handleScripts(member, map) {
        const lscrId = map?.[Magic.LSCR] || map?.[Magic.LSCR.toLowerCase()] || map?.['rcsL'];
        const lctxId = map?.[Magic.LCTX] || map?.[Magic.LCTX.toLowerCase()] || map?.['XtcL'];

        const lscrData = lscrId ? await this.dirFile.getChunkData(this.dirFile.getChunkById(lscrId)) : null;
        const lctxData = lctxId ? await this.dirFile.getChunkData(this.dirFile.getChunkById(lctxId)) : null;

        if (lscrData) {
            const decompiled = this.lingoDecompiler.decompile(lscrData, lctxData, this.nameTable);
            if (decompiled && decompiled.text) {
                const outPath = path.join(this.outputDir, `${member.name}.ls`);
                fs.writeFileSync(outPath, decompiled.text);
                member.scriptFile = `${member.name}.ls`;
                if (decompiled.text.includes(LingoConfig.Labels.ProtectedScript)) this.stats.protectedScripts++;
            }
        }
    }

    async matchDanglingScripts() {
        const scripts = this.members.filter(m => m.typeId === MemberType.Script && !m.scriptFile);
        const unusedLscr = this.dirFile.chunks.filter(c => c.type === Magic.LSCR && !this.resToMember[c.id]);

        if (scripts.length === unusedLscr.length && scripts.length > 0) {
            for (let i = 0; i < scripts.length; i++) {
                const data = await this.dirFile.getChunkData(unusedLscr[i]);
                const decompiled = this.lingoDecompiler.decompile(data, null, this.nameTable);
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

    saveResults() {
        fs.writeFileSync(path.join(this.outputDir, 'members.json'), JSON.stringify(this.metadata, null, 2));
        const logContent = this.extractionLog.map(e => `[${e.lvl.padEnd(5)}] ${e.msg}`).join('\n');
        fs.writeFileSync(path.join(this.outputDir, 'extraction.log'), logContent);
    }
}

module.exports = DirectorExtractor;
