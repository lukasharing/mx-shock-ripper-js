/**
 * @version 1.2.2
 * DirectorExtractor.js - Refactored modular orchestrator for Director assets
 */

const fs = require('fs');
const path = require('path');

const DirectorFile = require('./DirectorFile');
const BaseExtractor = require('./extractor/BaseExtractor');
const MetadataManager = require('./extractor/MetadataManager');
const MovieProcessor = require('./extractor/MovieProcessor');
const MemberProcessor = require('./extractor/MemberProcessor');
const ScriptHandler = require('./extractor/ScriptHandler');

const TextExtractor = require('./member/TextExtractor');
const BitmapExtractor = require('./member/BitmapExtractor');
const PaletteExtractor = require('./member/PaletteExtractor');
const ScriptExtractor = require('./member/ScriptExtractor');
const SoundExtractor = require('./member/SoundExtractor');
const ShapeExtractor = require('./member/ShapeExtractor');
const FontExtractor = require('./member/FontExtractor');
const GenericExtractor = require('./member/GenericExtractor');
const LnamParser = require('./lingo/LnamParser');
const VectorShapeExtractor = require('./member/VectorShapeExtractor');
const MovieExtractor = require('./member/MovieExtractor');
const LingoDecompiler = require('./lingo/LingoDecompiler');

const { Magic, MemberType } = require('./Constants');
const Color = require('./utils/Color');

class DirectorExtractor extends BaseExtractor {
    constructor(inputPath, outputDir, options = {}) {
        super(inputPath, outputDir, {
            extractBitmap: options.bitmap ?? true,
            extractFont: options.font ?? true,
            extractScript: options.script ?? true,
            extractSound: options.sound ?? true,
            extractPalette: options.palette ?? true,
            extractShape: options.shape ?? true,
            extractXtra: options.xtra ?? true,
            extractText: options.text ?? true,
            extractField: options.field ?? true,
            extractVectorShape: options.vectorShape ?? true,
            extractFilmLoop: options.filmLoop ?? true,
            colored: options.colored ?? false,
            projectContext: options.projectContext || null,
            lasm: options.lasm ?? false
        });

        const logProxy = (lvl, msg) => this.log(lvl, msg);

        // Member Extractors
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
        this.vectorShapeExtractor = new VectorShapeExtractor(logProxy);
        this.movieExtractor = new MovieExtractor(logProxy);

        // Core Systems
        this.metadataManager = new MetadataManager(this);
        this.movieProcessor = new MovieProcessor(this);
        this.memberProcessor = new MemberProcessor(this);
        this.scriptHandler = new ScriptHandler(this);

        this.dirFile = null;
        this.members = [];
        this.sharedPalettes = {};
        this.defaultMoviePalette = null;
    }

    async extract() {
        this.log('INFO', `Starting extraction: ${this.inputPath}`);

        this.dirFile = new DirectorFile(null, (lvl, msg) => this.log(lvl, msg));
        if (!await this.dirFile.open(this.inputPath)) {
            this.log('ERROR', `Failed to open file: ${this.inputPath}`);
            return null;
        }

        if (!fs.existsSync(this.outputDir)) fs.mkdirSync(this.outputDir, { recursive: true });

        // Phase 1: Resource Discovery & Initialization
        await this.metadataManager.parseKeyTable();
        await this.metadataManager.parseNameTable();
        await this.metadataManager.parseLctxMap();
        await this.loadSharedPalettes(path.join(path.dirname(this.inputPath), 'shared_palettes.json'));

        // Phase 2: Movie-wide Extraction
        await this.movieProcessor.extractConfig();
        await this.movieProcessor.extractTimeline();
        await this.movieProcessor.extractCastList();

        // Phase 3: Global Palette Collection (Pass 1)
        const castChunks = this.dirFile.chunks.filter(c => DirectorFile.unprotect(c.type).toUpperCase() === Magic.CAST.toUpperCase());
        for (const chunk of castChunks) {
            const member = await this.metadataManager.parseMemberMetadata(chunk);
            if (member && member.typeId === MemberType.Palette) {
                const map = this.metadataManager.keyTable[member.id];
                await this.memberProcessor.processPalette(member, map);
            }
        }

        // Phase 4: Member Processing (Pass 2)
        for (const chunk of castChunks) {
            const memberId = this.metadataManager.resToMember[chunk.id] || chunk.id;
            const member = this.members.find(m => m.id === memberId);
            if (!member || member.typeId === MemberType.Palette) continue; // Already processed
            await this.memberProcessor.processMemberContent(member, chunk);
        }

        // Phase 5: Cleanup & Finalization
        await this.matchDanglingScripts();
        this.metadata.members = this.members.map(m => m.toJSON());
        this.saveJSON();
        this.saveLog();

        this.log('SUCCESS', `Extraction complete. Extracted ${this.members.length} members. Output: ${this.outputDir}`);
        return { path: this.outputDir, stats: this.stats };
    }

    async loadSharedPalettes(filePath) {
        if (!fs.existsSync(filePath)) return;
        try {
            const data = fs.readFileSync(filePath, 'utf8');
            const json = JSON.parse(data);
            this.sharedPalettes = json;
            this.log('SUCCESS', `Loaded ${Object.keys(json).length} shared palettes.`);
        } catch (e) {
            this.log('ERROR', `Failed to load shared palettes: ${e.message}`);
        }
    }

    async matchDanglingScripts() {
        const scripts = this.members.filter(m => m.typeId === MemberType.Script && !m.scriptFile);
        const lscrChunks = this.dirFile.chunks.filter(c => c.type === Magic.LSCR && !this.metadataManager.resToMember[c.id]);

        if (scripts.length > 0 && lscrChunks.length > 0) {
            this.log('INFO', `Attempting to match ${scripts.length} dangling scripts...`);
            for (let i = 0; i < Math.min(scripts.length, lscrChunks.length); i++) {
                const data = await this.dirFile.getChunkData(lscrChunks[i]);
                if (!data) continue;

                const decompiled = this.lingoDecompiler.decompile(data, this.metadataManager.nameTable);
                if (decompiled?.text) {
                    const outPath = path.join(this.outputDir, `${scripts[i].name}.ls`);
                    fs.writeFileSync(outPath, decompiled.text);
                    scripts[i].scriptFile = `${scripts[i].name}.ls`;
                }
            }
        }
    }
}

module.exports = DirectorExtractor;
