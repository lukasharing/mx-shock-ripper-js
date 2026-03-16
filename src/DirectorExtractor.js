/**
 * @version 1.4.2
 * DirectorExtractor - Orchestrates extraction of Director RIFX files.
 * Robust discovery architecture with regional palette resolution.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
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
const FlashExtractor = require('./extractor/FlashExtractor');
const DigitalVideoExtractor = require('./extractor/DigitalVideoExtractor');
const XtraExtractor = require('./extractor/XtraExtractor');
const DataStream = require('./utils/DataStream');

const { MemberType, Magic, Resources } = require('./Constants');
const { Palette } = require('./utils/Palette');
const Logger = require('./utils/Logger');

class DirectorExtractor extends BaseExtractor {
    constructor(inputPath, outputDir, options = {}) {
        super(options);
        this.inputPath = inputPath;
        this.outputDir = outputDir;
        this.castOrder = [];
        this.projectType = 'standard';
        this.options = options;
        this.concurrency = os.cpus().length || 1;

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
        this.projectContext = options.projectContext || null;

        this.dirFile = null;
        this.castLibs = [];
        this.sharedPalettes = {};
        this.defaultMoviePalette = null;
        this.stats = { total: 0, processed: 0, extracted: 0, skipped: 0, failed: 0, byType: {} };
        this.metadata = {};

        // Sub-Extractor Instances
        const logProxy = (lvl, msg) => this.log(lvl, msg);
        this.textExtractor = new TextExtractor(logProxy);
        this.bitmapExtractor = new BitmapExtractor(logProxy, this, 0);
        this.paletteExtractor = new PaletteExtractor(logProxy);
        this.scriptExtractor = new ScriptExtractor(logProxy);
        this.soundExtractor = new SoundExtractor(logProxy);
        this.shapeExtractor = new ShapeExtractor(logProxy);
        this.fontExtractor = new FontExtractor(logProxy, this);
        this.genericExtractor = new GenericExtractor(logProxy);
        this.lingoDecompiler = new LingoDecompiler(logProxy, this);
        this.lnamParser = new LnamParser(logProxy, this);
        this.vectorShapeExtractor = new VectorShapeExtractor(logProxy);
        this.movieExtractor = new MovieExtractor(logProxy);
        this.flashExtractor = new FlashExtractor(logProxy);
        this.digitalVideoExtractor = new DigitalVideoExtractor(logProxy);
        this.xtraExtractor = new XtraExtractor(logProxy);
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
                if (map) {
                    await this.memberProcessor.processPalette(member, map);
                }
            }
        }

        // Phase 4: Member Content Processing (Persistent Worker Pool)
        const contentTags = [
            Magic.CAST, Magic.CAS_STAR, Magic.CArT, Magic.cast_lower,
            Magic.BITD, Magic.DIB, Magic.dib_star, Magic.bitd_lower,
            Magic.STXT, Magic.stxt_lower, Magic.TEXT, Magic.text_lower, Magic.TXTS,
            Magic.SND, Magic.snd_lower, Magic.snd_star,
            Magic.VCSH // VectorShape content tag
        ];

        const seenIds = new Set();
        const processQueue = this.members.filter(m => {
            if (seenIds.has(m.id)) return false;
            seenIds.add(m.id);

            if (m.typeId === MemberType.Palette) return false;

            const map = this.metadataManager.keyTable[m.id] || {};
            const isLctxScript = m.typeId === MemberType.Script && (m.scriptId > 0 || this.metadataManager.lctxMap[m.id] !== undefined);

            if (Object.keys(map).length === 0 && !isLctxScript) return false;

            const primaryTag = this.getPrimaryTagForType(m.typeId);
            const hasPrimary = primaryTag && map[primaryTag];

            const tags = Object.keys(map);
            const hasContent = tags.some(t => contentTags.includes(t));

            if (!hasPrimary && !hasContent && !isLctxScript) {
                if (this.options.verbose) {

                }
                return false;
            }

            return true;
        });

        const currentMembersJSON = path.join(this.outputDir, 'members.json');
        const workers = [];
        const taskQueue = [...processQueue];
        let remaining = processQueue.length;

        const workerChunks = [];
        for (const c of this.dirFile.chunks) {
            const physicalOffset = this.dirFile.isAfterburned
                ? (this.dirFile.ilsBodyOffset + c.off)
                : (c.off + 8);

            workerChunks.push({
                id: c.id,
                off: c.off,
                len: c.len,
                physicalOffset,
                isIlsResident: c.isIlsResident,
                compType: c.compType,
                uncompLen: c.uncompLen,
                type: DirectorFile.unprotect(c.type)
            });
        }

        let ilsBody = null;
        if (this.dirFile.isAfterburned) {
            const ilsChunk = this.dirFile.getChunksByType('ILS ')[0] || this.dirFile.getChunkById(2);
            if (ilsChunk) ilsBody = await this.dirFile.getChunkData(ilsChunk);
        }

        for (let i = 0; i < this.concurrency; i++) {
            const worker = new Worker(path.join(__dirname, 'extractor', 'ExtractionWorker.js'), {
                workerData: {
                    fd: this.dirFile.fd,
                    keyTable: this.metadataManager.keyTable,
                    nameTable: this.metadataManager.nameTable,
                    chunks: workerChunks,
                    fmap: this.dirFile.fmap || {},
                    lctxMap: this.metadataManager.lctxMap || {},
                    castOrder: this.castOrder || [],
                    movieConfig: this.metadataManager.movieConfig || {},
                    resToMember: this.metadataManager.resToMember || {},
                    isAfterburned: this.dirFile.isAfterburned,
                    ilsBodyOffset: this.dirFile.ilsBodyOffset,
                    ilsBody: ilsBody,
                    options: {
                        verbose: this.options.verbose,
                        lasm: this.options.lasm,
                        force: !!this.options.force,
                        fast: !!this.options.fast,
                        colored: !!this.options.colored
                    }
                }
            });
            workers.push(worker);
        }

        this.metadataStore = {};
        if (fs.existsSync(currentMembersJSON)) {
            try {
                const prevData = JSON.parse(fs.readFileSync(currentMembersJSON, 'utf8'));
                if (prevData.members) {
                    for (const m of prevData.members) {
                        this.metadataStore[m.id] = { checksum: m.checksum };
                    }
                }
            } catch (e) {

            }
        }

        // Phase 4.1: Parallel Palette Resolution
        await Promise.all(processQueue.map(async (member) => {
            if (member.typeId === MemberType.Bitmap || member.typeId === MemberType.Shape) {
                member._resolvedPalette = await Palette.resolveMemberPalette(member, this) || null;
            }
        }));

        await new Promise((resolve, reject) => {
            if (remaining === 0) return resolve();

            const onWorkerMessage = async (worker, msg) => {
                if (msg.type === 'LOG') {
                    this.log(msg.level, `[Worker] ${msg.message}`);
                } else if (msg.type === 'DONE') {
                    const m = this.members.find(mem => mem.id === msg.id);
                    if (m) {
                        if (msg.renamed) m.name = msg.renamed;
                        m.checksum = msg.checksum;
                        m.scriptFile = msg.scriptFile;
                        m.width = msg.width;
                        m.height = msg.height;
                        m.format = msg.format;

                        if (this.metadataStore) {
                            this.metadataStore[m.id] = { checksum: m.checksum };
                        }
                    }
                    this.stats.processed++;
                    remaining--;
                    if (taskQueue.length > 0) {
                        sendTask(worker, taskQueue.shift());
                    } else if (remaining === 0) {
                        resolve();
                    }
                    this.log('INFO', `[${remaining} members left] Progress: ${((this.stats.processed / processQueue.length) * 100).toFixed(1)}%`);
                } else if (msg.type === 'SKIP') {
                    this.log('INFO', `Skipping member ${msg.id} (unchanged)`);
                    this.stats.skipped++;
                    remaining--;
                    if (taskQueue.length > 0) {
                        sendTask(worker, taskQueue.shift());
                    } else if (remaining === 0) {
                        resolve();
                    }
                    this.log('INFO', `[${remaining} members left] Progress: ${((this.stats.processed / processQueue.length) * 100).toFixed(1)}%`);
                } else if (msg.type === 'ERROR') {
                    this.log('ERROR', `Worker error for member ${msg.id}: ${msg.message}`);
                    remaining--;
                    if (taskQueue.length > 0) {
                        sendTask(worker, taskQueue.shift());
                    } else if (remaining === 0) {
                        resolve();
                    }
                    this.log('INFO', `[${remaining} members left] Progress: ${((this.stats.processed / processQueue.length) * 100).toFixed(1)}%`);
                }
            };

            const sendTask = async (worker, member) => {
                const outPathPrefix = path.join(this.outputDir, (member.name || `member_${member.id}`).replace(/[/\\?%*:|"<>]/g, '_'));

                if (member.typeId === MemberType.Script) {
                    // TODO: investigate if you got any better ways to resolve anonymous script names
                }

                let scriptChunkIndex = member._chunkIndex;
                if (member.typeId === MemberType.Script && !scriptChunkIndex) {
                    const lscrId = (member.scriptId > 0 && this.metadataManager.lctxMap[member.scriptId]) || 
                                   (this.metadataManager.lctxMap[member.id]);
                    if (lscrId) {
                        const chunk = this.dirFile.getChunkById(lscrId);
                        if (chunk) scriptChunkIndex = this.dirFile.chunks.indexOf(chunk);
                    }
                }

                worker.postMessage({
                    type: 'PROCESS',
                    member: {
                        id: member.id,
                        name: member.name,
                        typeId: member.typeId,
                        scriptId: member.scriptId,
                        scriptType: member.scriptType,
                        flags: member.flags,
                        ilsIndex: member._ilsIndex,
                        width: member.width,
                        height: member.height,
                        bitDepth: member.bitDepth,
                        paletteId: member.paletteId,
                        clutCastLib: member.clutCastLib,
                        _castFlags: member._castFlags,
                        _initialRect: member._initialRect,
                        rect: member.rect
                    },
                    outPathPrefix,
                    knownChecksum: this.metadataStore[member.id]?.checksum,
                    palette: member._resolvedPalette,
                    nameTable: (member.typeId === MemberType.Script) 
                        ? this.metadataManager.getNameTableForScript(this.dirFile.chunks[scriptChunkIndex]?.id) 
                        : null
                });
            };

            for (const worker of workers) {
                worker.on('message', (msg) => onWorkerMessage(worker, msg));
                worker.on('error', (err) => {
                    this.log('ERROR', `Worker thread error: ${err.message}`);
                    reject(err);
                });
                worker.on('exit', (code) => {
                    if (code !== 0 && !this._isStopping) {
                        const err = new Error(`Worker stopped with exit code ${code}`);
                        this.log('ERROR', err.message);
                        reject(err);
                    }
                });

                if (taskQueue.length > 0) {
                    sendTask(worker, taskQueue.shift());
                }
            }
        });

        // Terminate persistent workers
        this._isStopping = true;
        await Promise.all(workers.map(w => w.terminate()));

        this.log('SUCCESS', `Processed ${this.stats.processed} members.`);

        // Phase 5: Cleanup & Finalization
        await this.matchDanglingScripts();
        this.finalizeCastLibs();

        // Final Clean Pass
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

        this.metadata.movie = this.metadataManager.movieConfig || {};
        this.metadata.castLibs = this.castLibs;
        const finalMembers = this.members.filter(m => {
            const typeName = CastMember.getTypeName(m.typeId);
            return !(typeName === 'Null' && (!m.name || m.name.startsWith('member_')));
        });

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

        if (this.dirFile) this.dirFile.close();
        this.log('SUCCESS', `Extraction complete. Output: ${this.outputDir}`);
        return { path: this.outputDir, stats: this.stats };
    }

    getPrimaryTagForType(typeId) {
        switch (typeId) {
            case MemberType.Bitmap: return Magic.BITD;
            case MemberType.Text:
            case MemberType.Field: return Magic.STXT; // Prioritize STXT for metadata mapping, but TEXT is handled in worker
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
        const scripts = this.members.filter(m => m.typeId === MemberType.Script && !m.format);
        if (scripts.length === 0) return;
        const lscrChunks = this.dirFile.chunks.filter(c => c.type === Magic.LSCR && !this.metadataManager.resToMember[c.id]);
        if (lscrChunks.length === 0) return;

        const matchedChunkIds = new Set();

        // Pass 1a: Match via lctxMap (scriptId ONLY - highly reliable)
        for (const script of scripts) {
            let lscrId = 0;
            if (script.scriptId > 0 && this.metadataManager.lctxMap[script.scriptId]) {
                lscrId = this.metadataManager.lctxMap[script.scriptId];
            }

            if (!lscrId) continue;

            const chunk = lscrChunks.find(c => c.id === lscrId);
            if (!chunk || matchedChunkIds.has(chunk.id)) continue;
            matchedChunkIds.add(chunk.id);

            const data = await this.dirFile.getChunkData(chunk);
            if (!data) continue;

            const scriptChunkIndex = this.dirFile.chunks.indexOf(chunk);
            const resolvedNameTable = this.metadataManager.getNameTableForScript(chunk.id);

            const decompiled = this.lingoDecompiler.decompile(data, resolvedNameTable, script.scriptType || 0, script.id, { lasm: this.options.lasm });
            const source = (typeof decompiled === 'object') ? decompiled.source : decompiled;
            if (source) {
                let finalName = script.name;
                if (/^member_\d+$/.test(finalName)) {
                    // Try deterministic naming from LSCR header (factoryId) at offset 46
                    if (data && data.length >= 48) {
                        const hLen = data.readUInt16BE(16);
                        if (hLen >= 92) {
                            const factoryId = data.readInt16BE(46);
                            if (factoryId >= 0 && this.metadataManager.nameTable[factoryId]) {
                                finalName = this.metadataManager.nameTable[factoryId];
                                script.name = finalName;
                            }
                        }
                    }

                    if (/^member_\d+$/.test(finalName)) {
                        // Heuristic sniffing fallback
                        const match = String(source).match(/["']([a-zA-Z0-9_.-]+\.class)["']/i);
                        if (match && match[1]) {
                            finalName = match[1];
                            script.name = finalName;
                            this.log('INFO', `Heuristic algorithm renamed anonymous ${script.name} -> ${finalName}`);
                        }
                    }
                }
                const lsPath = path.join(this.outputDir, `${finalName}.ls`);
                fs.writeFileSync(lsPath, source);
                if (this.options.lasm && typeof decompiled === 'object' && decompiled.lasm) {
                    fs.writeFileSync(path.join(this.outputDir, `${finalName}.lasm`), decompiled.lasm);
                }
                script.format = Resources.Formats.LS;
            }
        }

        // Pass 1b: Fallback match via lctxMap (member id) for remaining unmatched scripts
        const partiallyUnmatchedScripts = scripts.filter(s => !s.format);
        for (const script of partiallyUnmatchedScripts) {
            let lscrId = 0;
            if (this.metadataManager.lctxMap[script.id]) {
                lscrId = this.metadataManager.lctxMap[script.id];
            }

            if (!lscrId) continue;

            const chunk = lscrChunks.find(c => c.id === lscrId);
            if (!chunk || matchedChunkIds.has(chunk.id)) continue;
            matchedChunkIds.add(chunk.id);

            const data = await this.dirFile.getChunkData(chunk);
            if (!data) continue;

            const scriptChunkIndex = this.dirFile.chunks.indexOf(chunk);
            const resolvedNameTable = this.metadataManager.getNameTableForScript(chunk.id);

            const decompiled = this.lingoDecompiler.decompile(data, resolvedNameTable, script.scriptType || 0, script.id, { lasm: this.options.lasm });
            const source = (typeof decompiled === 'object') ? decompiled.source : decompiled;
            if (source) {
                let finalName = script.name;
                if (/^member_\d+$/.test(finalName)) {
                    // Try deterministic naming from LSCR header (factoryId) at offset 46
                    if (data && data.length >= 48) {
                        const hLen = data.readUInt16BE(16);
                        if (hLen >= 92) {
                            const factoryId = data.readInt16BE(46);
                            if (factoryId >= 0 && this.metadataManager.nameTable[factoryId]) {
                                finalName = this.metadataManager.nameTable[factoryId];
                                script.name = finalName;
                            }
                        }
                    }

                    if (/^member_\d+$/.test(finalName)) {
                        // Heuristic sniffing fallback
                        const match = String(source).match(/["']([a-zA-Z0-9_.-]+\.class)["']/i);
                        if (match && match[1]) {
                            finalName = match[1];
                            script.name = finalName;
                            this.log('INFO', `Heuristic algorithm renamed anonymous ${script.name} -> ${finalName}`);
                        }
                    }
                }
                const lsPath = path.join(this.outputDir, `${finalName}.ls`);
                fs.writeFileSync(lsPath, source);
                if (this.options.lasm && typeof decompiled === 'object' && decompiled.lasm) {
                    fs.writeFileSync(path.join(this.outputDir, `${finalName}.lasm`), decompiled.lasm);
                }
                script.format = Resources.Formats.LS;
            }
        }

        // Pass 2: Positional fallback for remaining unmatched (last resort)
        const unmatchedScripts = scripts.filter(s => !s.format);
        const unmatchedChunks = lscrChunks.filter(c => !matchedChunkIds.has(c.id));
        if (unmatchedScripts.length > 0 && unmatchedChunks.length > 0) {
            this.log('WARNING', `matchDanglingScripts: positional fallback for ${unmatchedScripts.length} unresolved scripts`);
            for (let i = 0; i < Math.min(unmatchedScripts.length, unmatchedChunks.length); i++) {
                const data = await this.dirFile.getChunkData(unmatchedChunks[i]);
                if (!data) continue;
                
                const scriptChunkIndex = this.dirFile.chunks.indexOf(unmatchedChunks[i]);
                const resolvedNameTable = this.metadataManager.getNameTableForScript(unmatchedChunks[i].id);

                const decompiled = this.lingoDecompiler.decompile(data, resolvedNameTable, unmatchedScripts[i].scriptType || 0, unmatchedScripts[i].id, { lasm: this.options.lasm });
                const source = (typeof decompiled === 'object') ? decompiled.source : decompiled;
                if (source) {
                    let finalName = unmatchedScripts[i].name;
                    if (/^member_\d+$/.test(finalName)) {
                        // Try deterministic naming from LSCR header (factoryId) at offset 46
                        if (data && data.length >= 48) {
                            const hLen = data.readUInt16BE(16);
                            if (hLen >= 92) {
                                const factoryId = data.readInt16BE(46);
                                if (factoryId >= 0 && this.metadataManager.nameTable[factoryId]) {
                                    finalName = this.metadataManager.nameTable[factoryId];
                                    unmatchedScripts[i].name = finalName;
                                }
                            }
                        }

                        if (/^member_\d+$/.test(finalName)) {
                            const match = String(source).match(/["']([a-zA-Z0-9_.-]+\.class)["']/i);
                            if (match && match[1]) {
                                finalName = match[1];
                                unmatchedScripts[i].name = finalName;
                                this.log('INFO', `Heuristic algorithm renamed anonymous ${unmatchedScripts[i].name} -> ${finalName}`);
                            }
                        }
                    }
                    const lsPath = path.join(this.outputDir, `${finalName}.ls`);
                    fs.writeFileSync(lsPath, source);
                    if (this.options.lasm && typeof decompiled === 'object' && decompiled.lasm) {
                        fs.writeFileSync(path.join(this.outputDir, `${finalName}.lasm`), decompiled.lasm);
                    }
                    unmatchedScripts[i].format = Resources.Formats.LS;
                }
            }
        }
    }

    finalizeCastLibs() {
        if (this.castLibs.length === 0) return;
        fs.writeFileSync(path.join(this.outputDir, 'castlibs.json'), JSON.stringify({ casts: this.castLibs }, null, 2));
    }
}

module.exports = DirectorExtractor;
