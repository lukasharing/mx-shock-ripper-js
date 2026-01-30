/**
 * @version 1.4.0
 * DirectorExtractor - Orchestrates extraction of Director RIFX files.
 */

const fs = require('fs');
const path = require('path');

const DirectorFile = require('./DirectorFile');
const BaseExtractor = require('./extractor/BaseExtractor');
const MetadataManager = require('./extractor/MetadataManager');
const MovieProcessor = require('./extractor/MovieProcessor');
const MemberProcessor = require('./extractor/MemberProcessor');
const ScriptHandler = require('./extractor/ScriptHandler');

const { MemberType, Magic } = require('./Constants');
const { Palette, PALETTES } = require('./utils/Palette');
const { Color } = require('./utils/Color');
const Logger = require('./utils/Logger');

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

        // Use the new standard Logger
        this.logger = new Logger('DirectorExtractor', (lvl, msg) => super.log(lvl, msg));

        // Core Systems
        this.metadataManager = new MetadataManager(this);
        this.movieProcessor = new MovieProcessor(this);
        this.memberProcessor = new MemberProcessor(this);
        this.scriptHandler = new ScriptHandler(this);

        this.dirFile = null;
        this.members = [];
        this.castLibs = [];
        this.sharedPalettes = {};
        this.defaultMoviePalette = null;

        // Lazy instances
        this._extractors = {};
    }

    // Dynamic getters for lazy-loading to optimize memory
    get textExtractor() { return this._getExtractor('TextExtractor', './member/TextExtractor'); }
    get bitmapExtractor() { return this._getExtractor('BitmapExtractor', './member/BitmapExtractor', [Palette, 0]); }
    get paletteExtractor() { return this._getExtractor('PaletteExtractor', './member/PaletteExtractor'); }
    get scriptExtractor() { return this._getExtractor('ScriptExtractor', './member/ScriptExtractor'); }
    get soundExtractor() { return this._getExtractor('SoundExtractor', './member/SoundExtractor'); }
    get shapeExtractor() { return this._getExtractor('ShapeExtractor', './member/ShapeExtractor'); }
    get fontExtractor() { return this._getExtractor('FontExtractor', './member/FontExtractor'); }
    get genericExtractor() { return this._getExtractor('GenericExtractor', './member/GenericExtractor'); }
    get lingoDecompiler() { return this._getExtractor('LingoDecompiler', './lingo/LingoDecompiler'); }
    get lnamParser() { return this._getExtractor('LnamParser', './lingo/LnamParser'); }
    get vectorShapeExtractor() { return this._getExtractor('VectorShapeExtractor', './member/VectorShapeExtractor'); }
    get movieExtractor() { return this._getExtractor('MovieExtractor', './member/MovieExtractor'); }

    _getExtractor(name, requirePath, args = []) {
        if (!this._extractors[name]) {
            const ExtractorClass = require(requirePath);
            const logProxy = (lvl, msg) => this.log(lvl, msg);
            this._extractors[name] = new ExtractorClass(logProxy, ...args);
        }
        return this._extractors[name];
    }

    log(lvl, msg) {
        this.logger.log(lvl, msg);
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

                const decompiled = this.lingoDecompiler.decompile(data, this.metadataManager.nameTable);
                if (decompiled?.text) {
                    const outPath = path.join(this.outputDir, `${scripts[i].name}.ls`);
                    fs.writeFileSync(outPath, decompiled.text);
                    scripts[i].format = 'ls';
                }
            }
        }
    }

    finalizeCastLibs() {
        if (this.castLibs.length === 0) return;

        const crypto = require('crypto');

        for (const castLib of this.castLibs) {
            // CastLib logic: (id >> 16) + 1 matches standard Director runtime behavior where CastLibs are segmented by 65536.
            // Verified against ProjectorRays 'minMember' logic which typically aligns with this structure.
            // Edge case: If 'minMember' in MCsL is arbitrary and not aligned to 65536 boundaries, this might fail,
            // but standard Director files adhere to this.
            const libIndex = castLib.index;
            const libMembers = this.members
                .filter(m => (m.id >> 16) + 1 === libIndex)
                .sort((a, b) => a.id - b.id);

            if (libMembers.length > 0) {
                const compositeChecksum = libMembers.map(m => m.checksum).join('');
                if (compositeChecksum) {
                    castLib.checksum = crypto.createHash('sha256').update(compositeChecksum).digest('hex');
                }
            } else {
                // Empty CastLib gets a consistent hash of an empty string
                castLib.checksum = crypto.createHash('sha256').update('').digest('hex');
            }
        }

        fs.writeFileSync(path.join(this.outputDir, 'castlibs.json'), JSON.stringify({ casts: this.castLibs }, null, 2));
    }
}

module.exports = DirectorExtractor;
