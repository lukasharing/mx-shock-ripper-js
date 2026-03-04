/**
 * @version 1.4.9
 * ProjectExtractor.js - Multi-file orchestration & Global Resource Management
 * 
 * Handles the recursive discovery of linked cast libraries (.cct/.cst) and 
 * manages the global resource context (Shared Palettes, Shared Scripts) to 
 * ensure consistency during extraction across multiple files.
 */

const fs = require('fs');
const path = require('path');
const DirectorFile = require('./DirectorFile');
const CastMember = require('./CastMember');
const DataStream = require('./utils/DataStream');
const { Palette } = require('./utils/Palette');
const { Color } = require('./utils/Color');
const { Magic, KeyTableValues } = require('./Constants');

class ProjectExtractor {
    /**
     * @param {string} entryPath - Path to the primary movie (e.g., main.dcr)
     * @param {object} options - Global extraction settings
     * @param {Function} logger - Standardization callback
     */
    constructor(entryPath, options = {}, logger = null) {
        this.entryPath = entryPath;
        this.baseDir = path.dirname(entryPath);
        this.options = options;
        this.log = logger || ((lvl, msg) => {
            if (this.options.verbose === true || lvl === 'ERROR' || lvl === 'WARN' || lvl === 'WARNING') {
                console.log(`[ProjectExtractor][${lvl}] ${msg}`);
            }
        });
        this.loadedCasts = [];
        this.globalPalettes = {};
        this.memberCache = {}; // Global member lookup by [castLibPath][memberId]
        this.castCache = {};   // Metadata cache: [path] -> { chunks, memberMap, endianness, ilsBodyOffset, ilsBody }
        this.pendingCasts = {}; // Promise coalescing for loadCast
        this.pendingMembers = {}; // Promise coalescing for getMember
        this.memberToCastMap = new Map(); // Global Member ID -> Cast Path mapping
        this.isReady = false;
    }

    /**
     * Initializes the project context by loading the entry movie and its dependencies.
     */
    async init() {
        this.log('INFO', `Initializing project context from ${path.basename(this.entryPath)}...`);
        await this.loadCast(this.entryPath, true);
        if (this.options.scanDirectory) await this.scanDirectoryPalettes();
        this.buildGlobalPaletteList();
        this.isReady = true;
        this.log('SUCCESS', `Project context ready. Loaded ${this.loadedCasts.length} casts. Global palettes: ${Object.keys(this.globalPalettes).length}`);
    }

    /**
     * Scans the base directory for all cast files and indexes their palettes.
     */
    async scanDirectoryPalettes() {
        this.log('INFO', `Scanning directory for extra palettes: ${this.baseDir}`);
        const files = fs.readdirSync(this.baseDir);
        for (const file of files) {
            if (file.toLowerCase().endsWith('.cct') || file.toLowerCase().endsWith('.cst')) {
                const fullPath = path.join(this.baseDir, file);
                // Avoid reloading already loaded casts
                if (this.loadedCasts.some(c => path.resolve(c.path) === path.resolve(fullPath))) continue;

                try {
                    await this.loadCast(fullPath, false);
                } catch (e) {

                }
            }
        }
    }

    /**
     * Loads a single movie/cast and recursively follows its MCsL/Lscl linkage.
     */
    async loadCast(filePath, isEntry = false) {
        const absolutePath = path.resolve(filePath);
        if (this.pendingCasts[absolutePath]) return this.pendingCasts[absolutePath];

        this.pendingCasts[absolutePath] = (async () => {
            if (!fs.existsSync(absolutePath)) {
                this.log('WARN', `File not found: ${absolutePath}`);
                return;
            }

            // check cache first
            if (this.castCache[absolutePath]) {
                const cached = this.castCache[absolutePath];
                this.loadedCasts.push({ path: absolutePath, cluts: cached.cluts, memberMap: cached.memberMap });
                return;
            }

            this.log('INFO', `Loading cast metadata: ${path.basename(absolutePath)}`);
            const fd = fs.openSync(absolutePath, 'r');
            try {
                const stats = fs.fstatSync(fd);
                const df = new DirectorFile(fd, this.log, stats.size);
                await df.parse();
                await this.discoverLinkedCasts(df);

                const keyChunk = df.chunks.find(c => [Magic.KEY, Magic.KEY_SPACE, Magic.KEY_STAR].includes(c.type));
                const memberMap = {};

                if (keyChunk) {
                    const keyData = await df.getChunkData(keyChunk);
                    if (keyData) {
                        const ds = new DataStream(keyData, df.ds.endianness);
                        let firstWord = ds.readUint16();
                        if (firstWord === KeyTableValues.EndianMismatch || firstWord > 255) {
                            ds.endianness = ds.endianness === 'big' ? 'little' : 'big';
                            ds.seek(0);
                            firstWord = ds.readUint16();
                        }
                        const headerSize = firstWord === KeyTableValues.HeaderShort ? 12 : 20;
                        ds.seek(headerSize === 12 ? 8 : 16);
                        const usedCount = ds.readUint32();
                        ds.seek(headerSize);

                        for (let i = 0; i < usedCount; i++) {
                            if (ds.position + 12 > keyData.length) break;
                            const sectionID = ds.readInt32();
                            const castID = ds.readInt32();
                            const tag = ds.readFourCC();
                            if (!memberMap[castID]) memberMap[castID] = {};
                            memberMap[castID][tag] = sectionID;
                            this.memberToCastMap.set(castID, absolutePath);
                        }
                    }
                }

                const cluts = [];
                for (const [castID, resources] of Object.entries(memberMap)) {
                    if (resources[Magic.CLUT]) {
                        const clutChunk = df.chunks.find(c => c.id === resources[Magic.CLUT]);
                        if (clutChunk) {
                            const data = await df.getChunkData(clutChunk);
                            let name = `Palette_${castID}`;
                            const castResId = resources[Magic.CAST] || resources[Magic.CAS_STAR];
                            if (castResId) {
                                const castChunk = df.chunks.find(c => c.id === castResId);
                                if (castChunk) {
                                    try {
                                        const m = CastMember.fromChunk(castID, await df.getChunkData(castChunk), df.ds.endianness);
                                        if (m.name) name = m.name;
                                    } catch (e) { }
                                }
                            }
                            cluts.push({ id: castID, data: data ? Buffer.from(data) : null, source: path.basename(absolutePath), name });
                        }
                    }
                }

                this.castCache[absolutePath] = {
                    chunks: df.chunks,
                    memberMap,
                    cluts,
                    endianness: df.ds.endianness,
                    ilsBodyOffset: df.ilsBodyOffset,
                    ilsBody: df._ilsBody,
                    isAfterburned: df.isAfterburned
                };

                this.loadedCasts.push({ path: absolutePath, cluts, memberMap });
            } finally {
                fs.closeSync(fd);
            }
        })();

        return this.pendingCasts[absolutePath];
    }

    /**
     * Resolves a member across any loaded cast library.
     * @param {number} memberId - The target member ID
     * @param {number} castLibId - Optional cast library index (1-based)
     */
    async getMember(memberId, castLibId = 0) {
        // If castLibId is provided, look in that specific cast
        if (castLibId > 0 && this.loadedCasts[castLibId - 1]) {
            return await this.getMemberFromCast(this.loadedCasts[castLibId - 1], memberId);
        }

        // 1. O(1) Global Lookup via indexed map (High Performance)
        if (this.memberToCastMap.has(memberId)) {
            const castPath = this.memberToCastMap.get(memberId);
            const cast = this.loadedCasts.find(c => c.path === castPath);
            if (cast) {
                const member = await this.getMemberFromCast(cast, memberId);
                if (member) return member;
            }
        }

        // 2. Fallback to iterative search (if not indexed yet)
        for (const cast of this.loadedCasts) {
            const member = await this.getMemberFromCast(cast, memberId);
            if (member) return member;
        }

        return null;
    }

    /**
     * Internal helper to extract and cache a member from a loaded cast.
     */
    async getMemberFromCast(cast, memberId) {
        if (!cast || !cast.memberMap[memberId]) return null;

        const cacheKey = `${cast.path}_${memberId}`;
        if (this.memberCache[cacheKey]) return this.memberCache[cacheKey];
        if (this.pendingMembers[cacheKey]) return this.pendingMembers[cacheKey];

        this.pendingMembers[cacheKey] = (async () => {
            const cachedMetadata = this.castCache[cast.path];
            if (!cachedMetadata) return null;

            const fd = fs.openSync(cast.path, 'r');
            try {
                const stats = fs.fstatSync(fd);
                const df = new DirectorFile(fd, this.log, stats.size);

                // Fast-track: Restore parsed structure from metadata cache
                df.chunks = cachedMetadata.chunks;
                df.ds.endianness = cachedMetadata.endianness;
                df.ilsBodyOffset = cachedMetadata.ilsBodyOffset;
                df._ilsBody = cachedMetadata.ilsBody;
                df.isAfterburned = cachedMetadata.isAfterburned;
                df._reindexChunks();

                const resources = cast.memberMap[memberId];
                const castResId = resources[Magic.CAST] || resources[Magic.CAS_STAR] || resources[Magic.CArT] || resources[Magic.cast_lower];

                if (castResId) {
                    const chunk = df.chunks.find(c => c.id === castResId);
                    if (chunk) {
                        const castData = await df.getChunkData(chunk);
                        if (!castData) return null;

                        const member = CastMember.fromChunk(memberId, castData, df.ds.endianness);

                        // If it's a palette, attach the data
                        if (member.typeId === 4 && resources[Magic.CLUT]) {
                            const clutChunk = df.chunks.find(c => c.id === resources[Magic.CLUT]);
                            if (clutChunk) {
                                const paletteData = await df.getChunkData(clutChunk);
                                member.palette = paletteData ? Buffer.from(paletteData) : null;
                            }
                        }

                        this.memberCache[cacheKey] = member;
                        return member;
                    }
                }
            } catch (e) {
                this.log('ERROR', `Failed to resolve cross-cast member ${memberId} in ${path.basename(cast.path)}: ${e.message}`);
            } finally {
                fs.closeSync(fd);
            }
            return null;
        })();

        return this.pendingMembers[cacheKey];
    }

    /**
     * Scans for linked cast files by parsing strings in the MCsL chunk.
     * Normalizes platform-specific path separators (Mac COLON vs Win/Posix) 
     * to ensure robust discovery across different file origins.
     */
    async discoverLinkedCasts(df) {
        const mcsl = df.chunks.find(c => [Magic.MCsL, 'Lscl'].includes(c.type));
        if (!mcsl) return;

        const data = await df.getChunkData(mcsl);
        if (!data) return;

        // Extract potential paths manually to avoid V8 RegExp OOM on massive chunks
        const rawStrings = [];
        let currentString = '';
        for (let i = 0; i < data.length; i++) {
            const byte = data[i];
            if (byte >= 0x20 && byte <= 0x7E) {
                currentString += String.fromCharCode(byte);
            } else {
                if (currentString.length > 2) {
                    rawStrings.push(currentString);
                }
                currentString = '';
            }
        }
        if (currentString.length > 2) {
            rawStrings.push(currentString);
        }
        const castList = [];

        for (const raw of rawStrings) {
            const str = raw.trim();
            if (['Internal', 'Primary'].includes(str) || str.toLowerCase().startsWith('empty')) continue;

            // Normalize separators: Director on Classic Mac used ":", modern/Win uses "/" or "\"
            let normalized = str.replace(/:/g, '/').replace(/\\/g, '/');
            let possibleFilename = path.basename(normalized);

            if (possibleFilename) {
                const base = possibleFilename.replace(/\.(cst|cct|dcr|dir)$/i, '');
                const extensions = ['.cct', '.cst', '.dcr', '.dir'];

                let targetPath = null;
                for (const ext of extensions) {
                    const candidate = path.join(this.baseDir, base + ext);
                    if (fs.existsSync(candidate)) {
                        targetPath = candidate;
                        break;
                    }
                }

                if (targetPath && !this.loadedCasts.some(c => path.resolve(c.path) === path.resolve(targetPath))) {
                    castList.push(base);
                    await this.loadCast(targetPath);
                }
            }
        }
    }

    /**
     * Aggregates all discovered palettes into a prioritized global list.
     */
    buildGlobalPaletteList() {
        // Built-in palettes
        this.addPaletteReference("System_Mac", Palette.getMacSystem7(), "System");
        this.addPaletteReference("System_Win", Palette.getWindowsSystem(), "System");

        for (const cast of this.loadedCasts) {
            for (const clut of cast.cluts) {
                const colors = this.parseRawColors(clut.data);
                if (colors) {
                    this.addPaletteReference(clut.name, colors, clut.source);
                }
            }
        }
    }

    /**
     * Internal helper to track palette color data and its sources.
     */
    addPaletteReference(name, colors, source) {
        if (!this.globalPalettes[name]) {
            this.globalPalettes[name] = {
                colors: colors,
                references: []
            };
        }
        if (!this.globalPalettes[name].references.includes(source)) {
            this.globalPalettes[name].references.push(source);
        }
    }

    /**
     * Parses raw CLUT data.
     */
    parseRawColors(buffer) {
        return Palette.parseDirector(buffer);
    }

    getPalette(idOrName) {
        // Search by ID (legacy) or Name (modern)
        if (this.globalPalettes[idOrName]) {
            return this.globalPalettes[idOrName].colors;
        }

        // Fallback: search by id property in objects (if any were added with numeric keys)
        return null;
    }

    /**
     * Persists the consolidated global palette registry to disk.
     */
    savePalettes(outputDir) {
        const palettesPath = path.join(outputDir, 'palettes.json');
        fs.writeFileSync(palettesPath, JSON.stringify(this.globalPalettes, null, 2));
        this.log('SUCCESS', `Global palettes saved to: ${palettesPath}`);
    }

    getDefaultPalette() {
        const entryBase = path.basename(this.entryPath);
        // Look for any palette belonging to the movie
        for (const [name, data] of Object.entries(this.globalPalettes)) {
            if (data.references.includes(entryBase) && !name.startsWith("System_")) {
                return data.colors;
            }
        }
        // Fallback to first non-system palette
        for (const [name, data] of Object.entries(this.globalPalettes)) {
            if (!name.startsWith("System_")) return data.colors;
        }
        return Palette.getMacSystem7();
    }
}

module.exports = ProjectExtractor;
