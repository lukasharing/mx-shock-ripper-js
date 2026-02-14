/**
 * @version 1.3.5
 * DirectorExtractor - Orchestrates extraction of Director RIFX files.
 * Robust discovery architecture with clean imports.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DirectorFile = require('./DirectorFile');
const BaseExtractor = require('./extractor/BaseExtractor');
const MetadataManager = require('./extractor/MetadataManager');
const MovieProcessor = require('./extractor/MovieProcessor');
const MemberProcessor = require('./extractor/MemberProcessor');
const ScriptHandler = require('./extractor/ScriptHandler');
const CastMember = require('./CastMember');
const CastManager = require('./extractor/CastManager');

// Sub-Extractors
const TextExtractor = require('./member/TextExtractor');
const BitmapExtractor = require('./member/BitmapExtractor');
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

const { MemberType, Magic } = require('./Constants');
const { Palette, PALETTES } = require('./utils/Palette');
const { Color } = require('./utils/Color');
const Logger = require('./utils/Logger');

class DirectorExtractor extends BaseExtractor {
    constructor(inputPath, outputDir, options = {}) {
        super(options);
        this.inputPath = inputPath;
        this.outputDir = outputDir;
        this.castOrder = [];
        this.projectType = 'standard';
        this.options = options;

        this.logger = new Logger('DirectorExtractor', (lvl, msg) => {
            this.extractionLog.push({ timestamp: new Date().toISOString(), lvl, msg });
            if (['INFO', 'SUCCESS', 'ERROR', 'WARN', 'WARNING'].includes(lvl)) {
                console.log(`[DirectorExtractor][${lvl}] ${msg}`);
            }
        });

        // Core Systems
        this.metadataManager = new MetadataManager(this);
        this.castManager = new CastManager(this);
        this.movieProcessor = new MovieProcessor(this);
        this.memberProcessor = new MemberProcessor(this);
        this.scriptHandler = new ScriptHandler(this);

        this.dirFile = null;
        this.castLibs = [];
        this.sharedPalettes = {};
        this.defaultMoviePalette = null;
        this.stats = { total: 0, extracted: 0, failed: 0, byType: {} };
        this.metadata = {};

        // Sub-Extractor Instances
        const logProxy = (lvl, msg) => this.log(lvl, msg);
        this.textExtractor = new TextExtractor(logProxy);
        this.bitmapExtractor = new BitmapExtractor(logProxy, this, 0);
        this.paletteExtractor = new PaletteExtractor(logProxy);
        this.scriptExtractor = new ScriptExtractor(logProxy);
        this.soundExtractor = new SoundExtractor(logProxy);
        this.shapeExtractor = new ShapeExtractor(logProxy);
        this.fontExtractor = new FontExtractor(logProxy);
        this.genericExtractor = new GenericExtractor(logProxy);
        this.lingoDecompiler = new LingoDecompiler(logProxy, this);
        this.lnamParser = new LnamParser(logProxy);
        this.vectorShapeExtractor = new VectorShapeExtractor(logProxy);
        this.movieExtractor = new MovieExtractor(logProxy);
    }

    get members() {
        return this.castManager.members;
    }

    log(lvl, msg) {
        this.logger.log(lvl, msg);
    }

    async extract() {
        console.log(`[DEBUG_EXTRACT] Starting extract for ${this.inputPath}`);
        this.log('INFO', `Starting extraction: ${this.inputPath}`);

        this.dirFile = new DirectorFile(null, (lvl, msg) => this.log(lvl, msg));
        if (!await this.dirFile.open(this.inputPath)) {
            this.log('ERROR', `Failed to open file: ${this.inputPath}`);
            return null;
        }

        if (!fs.existsSync(this.outputDir)) fs.mkdirSync(this.outputDir, { recursive: true });

        // Phase 1: Structural Discovery & Key Metadata
        await this.metadataManager.parseKeyTable();
        await this.metadataManager.parseMCsL();
        await this.metadataManager.parseNameTable();
        await this.metadataManager.parseDRCF();
        await this.metadataManager.dumpCCL();
        await this.loadSharedPalettes(path.join(path.dirname(this.inputPath), 'shared_palettes.json'));

        // [Discovery] Let CastManager aggregate all unique Member IDs
        await this.castManager.discoverMembers();

        // Phase 2: Metadata Enrichment & Movie-wide Extraction
        await this.movieProcessor.extractConfig();
        await this.movieProcessor.extractTimeline();
        await this.movieProcessor.extractCastList();

        // [Enrichment] Combined pass orchestration handled by CastManager
        await this.castManager.enrichPass1();
        await this.castManager.enrichPass2();

        // Phase 3: Global Palette Collection
        for (const member of this.members) {
            if (member.typeId === MemberType.Palette) {
                const map = this.metadataManager.keyTable[member.id];
                await this.memberProcessor.processPalette(member, map);
                if (member.palette) {
                    this.log('INFO', `[PalettePhase] Attached palette data to Member ${member.id} (${member.name}).`);
                }
            }
        }

        // Phase 4: Member Content Processing
        for (const member of this.members) {
            if (member.typeId === MemberType.Palette) continue;
            const map = this.metadataManager.keyTable[member.id];
            if (!map) continue;

            const sectionId = map[Magic.CAST] || map['CAS*'] || map['CAsT'] || map['cast'] ||
                map[Magic.BITD] || map['ABMP'] || map[Magic.STXT] || Object.values(map)[0];

            const chunk = this.dirFile.getChunkById(sectionId);
            if (chunk) {
                await this.memberProcessor.processMemberContent(member, chunk);
            }
        }

        // Phase 5: Cleanup & Finalization
        await this.matchDanglingScripts();
        this.finalizeCastLibs();
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

                const decompiled = this.lingoDecompiler.decompile(data, this.metadataManager.nameTable, 0, scripts[i].id, { lasm: this.options.lasm });
                const source = (typeof decompiled === 'object') ? decompiled.source : decompiled;
                if (source) {
                    const lsPath = path.join(this.outputDir, `${scripts[i].name}.ls`);
                    fs.writeFileSync(lsPath, source);
                    if (this.options.lasm && typeof decompiled === 'object' && decompiled.lasm) {
                        fs.writeFileSync(path.join(this.outputDir, `${scripts[i].name}.lasm`), decompiled.lasm);
                    }
                    if (this.options.saveLsc) {
                        fs.writeFileSync(path.join(this.outputDir, `${scripts[i].name}.lsc`), data);
                    }
                    scripts[i].format = 'ls';
                }
            }
        }
    }

    getCastLibHash(castLibIndex, algorithm = 'sha256') {
        const libMembers = this.members
            .filter(m => (m.id >> 16) + 1 === castLibIndex)
            .sort((a, b) => a.id - b.id);
        if (libMembers.length === 0) return crypto.createHash(algorithm).update('').digest('hex');
        const compositeChecksum = libMembers.map(m => m.checksum).join('');
        return crypto.createHash(algorithm).update(compositeChecksum).digest('hex');
    }

    finalizeCastLibs() {
        if (this.castLibs.length === 0) return;
        for (const castLib of this.castLibs) castLib.checksum = this.getCastLibHash(castLib.index);
        fs.writeFileSync(path.join(this.outputDir, 'castlibs.json'), JSON.stringify({ casts: this.castLibs }, null, 2));
    }
}

module.exports = DirectorExtractor;
