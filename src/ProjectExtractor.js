/**
 * @version 1.1.5
 * ProjectExtractor.js - Strategic orchestrator for multi-movie Director projects
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
const Color = require('./utils/Color');
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
        this.log = logger || ((lvl, msg) => console.log(`[ProjectExtractor][${lvl}] ${msg}`));
        this.loadedCasts = [];
        this.globalPalettes = [];
        this.isReady = false;
    }

    /**
     * Initializes the project context by loading the entry movie and its dependencies.
     */
    async init() {
        this.log('INFO', `Initializing project context from ${path.basename(this.entryPath)}...`);
        await this.loadCast(this.entryPath, true);
        this.buildGlobalPaletteList();
        this.isReady = true;
        this.log('SUCCESS', `Project context ready. Loaded ${this.loadedCasts.length} casts.`);
    }

    /**
     * Loads a single movie/cast and recursively follows its MCsL/Lscl linkage.
     */
    async loadCast(filePath, isEntry = false) {
        if (!fs.existsSync(filePath)) {
            this.log('WARN', `File not found: ${filePath}`);
            return;
        }

        const buffer = fs.readFileSync(filePath);
        const df = new DirectorFile(buffer, this.log);
        await df.parse();

        if (isEntry) await this.discoverLinkedCasts(df);

        const keyChunk = df.chunks.find(c => [Magic.KEY, 'KEY ', Magic.KEYStar].includes(c.type));
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
                    const castResId = resources[Magic.CAST] || resources[Magic.CASStar];
                    if (castResId) {
                        const castChunk = df.chunks.find(c => c.id === castResId);
                        if (castChunk) {
                            try {
                                const m = CastMember.fromChunk(castID, await df.getChunkData(castChunk), df.ds.endianness);
                                if (m.name) name = m.name;
                            } catch (e) { }
                        }
                    }
                    cluts.push({ id: castID, data, source: path.basename(filePath), name });
                }
            }
        }

        this.loadedCasts.push({ path: filePath, cluts });
    }

    /**
     * Parses the MCsL (Movie Cast List) to identify external dependencies.
     */
    async discoverLinkedCasts(df) {
        const mcsl = df.chunks.find(c => [Magic.MCsL, 'Lscl'].includes(c.type));
        if (!mcsl) return;

        const data = await df.getChunkData(mcsl);
        const rawStrings = data.toString('utf8').replace(/[^\x20-\x7E]/g, '\0').split('\0').filter(s => s.length > 2);
        const castList = [];

        for (const raw of rawStrings) {
            const str = raw.trim();
            if (['Internal', 'Primary'].includes(str) || str.toLowerCase().startsWith('empty')) continue;

            let possibleFilename = null;
            if (str.match(/\.(cst|cct|dcr|dir)$/i)) possibleFilename = path.basename(str);
            else if (!str.includes(':') && !str.includes('\\') && !str.includes('/')) possibleFilename = str;

            if (possibleFilename) {
                const base = possibleFilename.replace(/\.(cst|cct|dcr|dir)$/i, '');
                if (base === 'Habbo') continue;

                let targetPath = null;
                if (fs.existsSync(path.join(this.baseDir, base + '.cct'))) targetPath = path.join(this.baseDir, base + '.cct');
                else if (fs.existsSync(path.join(this.baseDir, base + '.dcr'))) targetPath = path.join(this.baseDir, base + '.dcr');

                if (targetPath && !castList.includes(base) && !this.loadedCasts.some(c => c.path === targetPath)) {
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
        this.globalPalettes = [
            { colors: Color.getMacSystem7(), name: "System_Mac", source: "System" },
            { colors: Color.getWindowsSystem(), name: "System_Win", source: "System" }
        ];

        for (const cast of this.loadedCasts) {
            for (const clut of cast.cluts) {
                const colors = this.parseRawColors(clut.data);
                if (colors) this.globalPalettes.push({ colors, name: clut.name, source: clut.source });
            }
        }
    }

    /**
     * Parses raw CLUT data, handling 3-byte and 4-byte channel structures.
     */
    parseRawColors(buffer) {
        if (!buffer || buffer.length === 0) return null;
        const colors = [];
        let offset = 0;

        if (buffer.length === 768) offset = 0;
        else if (buffer.length > 768 && (buffer.length - 768) < 20) offset = buffer.length - 768;

        for (let i = offset; i < buffer.length; i += 3) {
            if (colors.length >= 256 || i + 3 > buffer.length) break;
            colors.push([buffer[i], buffer[i + 1], buffer[i + 2]]);
        }

        if (colors.length < 255 && buffer.length >= 1024) {
            colors.length = 0;
            offset = buffer.length === 1024 ? 0 : (buffer.length - 1024);
            for (let i = offset; i < buffer.length; i += 4) {
                if (colors.length >= 256) break;
                colors.push([buffer[i], buffer[i + 1], buffer[i + 2]]);
            }
        }
        return colors.length > 0 ? colors : null;
    }

    getPalette(index) {
        const entry = this.globalPalettes[index - 1];
        return entry ? entry.colors : null;
    }

    getDefaultPalette() {
        const entryBase = path.basename(this.entryPath);
        const MoviePal = this.globalPalettes.find(p => p.source === entryBase && p.source !== "System");
        if (MoviePal) return MoviePal;
        return this.globalPalettes.find(p => p.source !== "System") || this.globalPalettes[0];
    }
}

module.exports = ProjectExtractor;
