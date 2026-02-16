/**
 * @version 1.4.0
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
const DataStream = require('./utils/DataStream');

const { MemberType, Magic, Resources } = require('./Constants');
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

        const contentTags = [
            Magic.CAST, Magic.CAS_STAR, Magic.CArT, Magic.cast_lower,
            Magic.BITD, Magic.DIB, Magic.dib_star, Magic.bitd_lower,
            Magic.STXT, Magic.stxt_lower, Magic.TXTS,
            Magic.SND, Magic.snd_lower, Magic.snd_star
        ];

        const processQueue = this.members.filter(m => {
            if (m.typeId === MemberType.Palette) return false;

            const map = this.metadataManager.keyTable[m.id];
            if (!map) return false;

            // Strict Content Check:
            // We only process members that either have their "primary" chunk (BITD, LSCR, etc.)
            // OR at least one of the known content tags (DIB, STXT, etc.).
            // This prevents flooding with phantom/Thum-only members.
            const primaryTag = this.getPrimaryTagForType(m.typeId);
            const hasPrimary = primaryTag && map[primaryTag];

            const tags = Object.keys(map);
            const hasContent = tags.some(t => contentTags.includes(t));

            if (!hasPrimary && !hasContent) {
                if (this.options.verbose) {
                    this.log('DEBUG', `Skipping member ${m.id} (${m.name}): no content chunks found (Tags: ${tags.join(', ')})`);
                }
                return false;
            }

            return true;
        });
        const workers = [];
        const taskQueue = [...processQueue];
        let completedCount = 0;

        // Initialize persistent workers with accurate ILS offsets
        const ilsOffsets = {};
        if (this.dirFile.isAfterburned && this.dirFile.ilsBodyOffset > 0) {
            const ilsChunk = this.dirFile.chunks.find(c => c.type === Magic.ILS || c.id === 2);
            if (ilsChunk) {
                const ilsData = await this.dirFile.getChunkData(ilsChunk);
                if (ilsData) {
                    const ds = new DataStream(ilsData, this.dirFile.ds.endianness);
                    let currentPos = this.dirFile.ilsBodyOffset;
                    while (ds.position < ds.length) {
                        const resId = ds.readVarInt();
                        const chunk = this.dirFile.chunks.find(c => c.id === resId);
                        if (chunk) {
                            ilsOffsets[resId] = currentPos;
                            if (resId === 4361 || resId === 1024) {
                                console.log(`[DirectorExtractor][DEBUG] Found ILS offset for ${resId}: ${currentPos}`);
                            }
                            currentPos += chunk.len;
                        } else {
                            break;
                        }
                    }
                }
            }
        }

        for (let i = 0; i < this.concurrency; i++) {
            const worker = new Worker(path.join(__dirname, 'extractor', 'ExtractionWorker.js'), {
                workerData: {
                    fd: this.dirFile.fd,
                    keyTable: this.metadataManager.keyTable,
                    nameTable: this.metadataManager.nameTable,
                    chunks: this.dirFile.chunks.map(c => ({
                        ...c,
                        physicalOffset: ilsOffsets[c.id] || (this.dirFile.isAfterburned ? (this.dirFile.ilsBodyOffset + c.off) : (c.off + 8))
                    })),
                    fmap: this.dirFile.fmap || {},
                    isAfterburned: this.dirFile.isAfterburned,
                    ilsBodyOffset: this.dirFile.ilsBodyOffset,
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
                                    if (msg.result.checksum) member.checksum = msg.result.checksum;
                                }
                                workerObj.busy = false;
                                workerObj.thread.off('message', onMessage);
                                completedCount++;
                                distributeTasks();
                            } else if (msg.type === 'error' && msg.memberId === member.id) {
                                this.log('ERROR', `Worker error for ${member.id}: ${msg.error}`);
                                // Fallback Assignment: Ensure member has a format even on failure
                                if (!member.format) {
                                    if (member.typeId === MemberType.Bitmap) member.format = Resources.Formats.PNG;
                                    else if (member.typeId === MemberType.Script) member.format = Resources.Formats.LS;
                                    else if (member.typeId === MemberType.Text) member.format = Resources.Formats.RTF;
                                }
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

        // Final Clean Pass: Ensure NO member has a null format
        for (const member of this.members) {
            if (!member.format) {
                if (member.typeId === MemberType.Bitmap) member.format = Resources.Formats.PNG;
                else if (member.typeId === MemberType.Script) member.format = Resources.Formats.LS;
                else if (member.typeId === MemberType.Text || member.typeId === MemberType.Field) member.format = Resources.Formats.RTF;
                else if (member.typeId === MemberType.Sound) member.format = Resources.Formats.WAV;
                else if (member.typeId === MemberType.Palette) member.format = Resources.Formats.PAL;
                else member.format = Resources.Formats.DAT;
            }
        }

        // Consolidation: Add global contexts to metadata
        this.metadata.movie = this.metadataManager.movieConfig || {};
        this.metadata.castLibs = this.castLibs;

        const finalMembers = this.members.filter(m => {
            // Filter out empty slots (Type 0 with no descriptive name)
            const typeName = CastMember.getTypeName(m.typeId);
            return !(typeName === 'Null' && (!m.name || m.name.startsWith('member_')));
        });

        // Re-calculate stats based on final members
        this.stats.total = finalMembers.length;
        this.stats.byType = {};
        for (const m of finalMembers) {
            const t = CastMember.getTypeName(m.typeId);
            this.stats.byType[t] = (this.stats.byType[t] || 0) + 1;
        }

        this.metadata.stats = this.stats;
        this.metadata.members = finalMembers.map(m => m.toJSON());

        this.saveJSON();
        this.saveLog();

        this.dirFile.close();
        this.log('SUCCESS', `Extraction complete. Extracted ${this.members.length} members. Output: ${this.outputDir}`);
        return { path: this.outputDir, stats: this.stats };
    }

    getPrimaryTagForType(typeId) {
        switch (typeId) {
            case MemberType.Bitmap: return Magic.BITD;
            case MemberType.Text:
            case MemberType.Field: return Magic.STXT;
            case MemberType.Script: return Magic.LSCR;
            case MemberType.Sound: return Magic.SND;
            case MemberType.Shape:
            case MemberType.Button: return Magic.CAST;
            case MemberType.VectorShape: return Magic.VCSH;
            case MemberType.Movie: return Magic.VWCF;
            case MemberType.Palette: return Magic.CLUT;
            default: return null;
        }
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
                    scripts[i].format = Resources.Formats.LS;
                }
            }
        }
    }

    getCastLibHash(castLibIndex, algorithm = 'sha256') {
        const libMembers = this.members
            .filter(m => (m.id >> 16) + 1 === castLibIndex)
            .sort((a, b) => {
                // Use checksum for order-independent hashing (Set Consensus)
                // Fallback to ID if checksum is missing (phantom members)
                if (a.checksum && b.checksum) return a.checksum.localeCompare(b.checksum);
                return a.id - b.id;
            });
        if (libMembers.length === 0) return crypto.createHash(algorithm).update('').digest('hex');
        const compositeChecksum = libMembers.map(m => m.checksum || m.id).join('');
        return crypto.createHash(algorithm).update(compositeChecksum).digest('hex');
    }

    finalizeCastLibs() {
        if (this.castLibs.length === 0) return;
        for (const castLib of this.castLibs) castLib.checksum = this.getCastLibHash(castLib.index);
        fs.writeFileSync(path.join(this.outputDir, 'castlibs.json'), JSON.stringify({ casts: this.castLibs }, null, 2));
    }

}

module.exports = DirectorExtractor;
