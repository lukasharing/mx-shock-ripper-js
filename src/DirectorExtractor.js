/**
 * @version 1.3.7
 * DirectorExtractor - Orchestrates extraction of Director RIFX files.
 * Robust discovery architecture with regional palette resolution.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Worker } = require('worker_threads');

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
        this.concurrency = options.concurrency || 8;

        this.logger = new Logger('DirectorExtractor', (lvl, msg) => {
            this.extractionLog.push({ timestamp: new Date().toISOString(), lvl, msg });
            if ((['ERROR', 'WARN', 'WARNING'].includes(lvl)) || (this.options.verbose === true)) {
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
        this.log('INFO', `Starting extraction: ${this.inputPath}`);

        if (!fs.existsSync(this.inputPath)) {
            this.log('ERROR', `File not found: ${this.inputPath}`);
            return null;
        }

        const stats = fs.statSync(this.inputPath);
        const fd = fs.openSync(this.inputPath, 'r');
        this.dirFile = new DirectorFile(fd, (lvl, msg) => this.log(lvl, msg), stats.size);
        try {
            await this.dirFile.parse();
        } catch (e) {
            this.dirFile.close();
            this.log('ERROR', `Failed to parse Director file: ${e.message}`);
            return null;
        }

        if (!fs.existsSync(this.outputDir)) fs.mkdirSync(this.outputDir, { recursive: true });

        // Phase 1: Structural Discovery & Key Metadata
        await this.metadataManager.parseKeyTable();
        await this.metadataManager.parseMCsL();
        await this.metadataManager.parseNameTable();
        await this.metadataManager.parseDRCF();
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
            }
        }

        // Phase 4: Member Content Processing (Persistent Worker Pool)
        this.log('INFO', `Processing ${this.members.length} members with persistent Worker Pool (Threads: ${this.concurrency})`);

        const processQueue = this.members.filter(m => {
            if (m.typeId === MemberType.Palette) return false;
            // Skip members that have no physical mapping in the keyTable (phantom slots)
            return !!this.metadataManager.keyTable[m.id];
        });
        const workers = [];
        const taskQueue = [...processQueue];
        let completedCount = 0;

        // Initialize persistent workers
        for (let i = 0; i < this.concurrency; i++) {
            const worker = new Worker(path.join(__dirname, 'extractor', 'ExtractionWorker.js'), {
                workerData: {
                    fd: this.dirFile.fd,
                    keyTable: this.metadataManager.keyTable,
                    nameTable: this.metadataManager.nameTable,
                    chunks: this.dirFile.chunks.map(c => ({ id: c.id, offset: this.dirFile.isAfterburned ? (this.dirFile.ilsBodyOffset + c.off) : (c.off + 8), size: c.len })),
                    options: { verbose: this.options.verbose, lasm: this.options.lasm }
                }
            });

            worker.on('error', (err) => this.log('ERROR', `Worker ${i} error: ${err.message}`));
            worker.on('exit', (code) => {
                if (code !== 0 && !this._isStopping) this.log('ERROR', `Worker ${i} stopped with exit code ${code}`);
            });

            workers.push({ thread: worker, busy: false });
        }

        await new Promise((resolve) => {
            const distributeTasks = async () => {
                if (completedCount === processQueue.length) {
                    resolve();
                    return;
                }

                for (const workerObj of workers) {
                    if (!workerObj.busy && taskQueue.length > 0) {
                        const member = taskQueue.shift();
                        workerObj.busy = true;

                        const outPathPrefix = path.join(this.outputDir, (member.name || `member_${member.id}`).replace(/[/\\?%*:|"<>]/g, '_'));
                        const finalPalette = await Palette.resolveMemberPalette(member, this);

                        const task = {
                            member: {
                                id: member.id,
                                name: member.name,
                                typeId: member.typeId,
                                width: member.width,
                                height: member.height,
                                bitDepth: member.bitDepth,
                                _initialRect: member._initialRect
                            },
                            outPathPrefix,
                            palette: finalPalette
                        };

                        const onMessage = (msg) => {
                            if (msg.type === 'log') {
                                this.log(msg.lvl, msg.msg);
                            } else if (msg.type === 'result' && msg.memberId === member.id) {
                                if (msg.result) {
                                    member.image = msg.result.file || msg.result.path;
                                    member.format = msg.result.format;
                                    if (msg.result.width) member.width = msg.result.width;
                                    if (msg.result.height) member.height = msg.result.height;
                                }
                                workerObj.busy = false;
                                workerObj.thread.off('message', onMessage);
                                completedCount++;
                                distributeTasks();
                            } else if (msg.type === 'error' && msg.memberId === member.id) {
                                this.log('ERROR', `Worker error for ${member.id}: ${msg.error}`);
                                workerObj.busy = false;
                                workerObj.thread.off('message', onMessage);
                                completedCount++;
                                distributeTasks();
                            }
                        };

                        workerObj.thread.on('message', onMessage);
                        workerObj.thread.postMessage(task);
                    }
                }
            };
            distributeTasks();
        });

        // Terminate persistent workers
        this._isStopping = true;
        for (const w of workers) w.thread.terminate();

        this.log('SUCCESS', `Processed ${completedCount}/${processQueue.length} members successfully.`);

        // Phase 5: Cleanup & Finalization
        await this.matchDanglingScripts();
        this.finalizeCastLibs();
        this.metadata.members = this.members.map(m => m.toJSON());
        this.saveJSON();
        this.saveLog();

        this.dirFile.close();
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
