const { parentPort, workerData } = require('worker_threads');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const zlib = require('zlib');

const BitmapExtractor = require('../member/BitmapExtractor');
const PaletteExtractor = require('../member/PaletteExtractor');
const TextExtractor = require('../member/TextExtractor');
const SoundExtractor = require('../member/SoundExtractor');
const ScriptExtractor = require('../member/ScriptExtractor');
const ShapeExtractor = require('../member/ShapeExtractor');
const FontExtractor = require('../member/FontExtractor');
const VectorShapeExtractor = require('../member/VectorShapeExtractor');
const MovieExtractor = require('../member/MovieExtractor');
const GenericExtractor = require('../member/GenericExtractor');
const LingoDecompiler = require('../lingo/LingoDecompiler');
const { MemberType, Magic, Resources } = require('../Constants');

/**
 * ExtractionWorker.js (Level 3 - Zero Contention)
 * Uses shared FD and metadata to perform autonomous Disk I/O.
 */

const { fd, keyTable, nameTable, chunks, fmap, lctxMap, options: workerOptions, isAfterburned, ilsBodyOffset } = workerData;


const logProxy = (lvl, msg, memberId) => {
    parentPort.postMessage({ type: 'LOG', level: lvl, message: msg, memberId });
};

// Autonomous Data Accessor (Simplified version of DirectorFile logic for Worker)
// O(1) chunk lookup map built once at startup
const chunkMap = new Map();
for (const chunk of chunks) {
    // Use fmap to resolve logical → physical ID
    const physicalId = (fmap && fmap[chunk.id] !== undefined) ? fmap[chunk.id] : chunk.id;
    if (!chunkMap.has(physicalId)) chunkMap.set(physicalId, chunk);
}

const getChunkById = (id) => {
    const physicalId = (fmap && fmap[id] !== undefined) ? fmap[id] : id;
    return chunkMap.get(physicalId) || null;
};

const getChunkData = async (chunk) => {
    if (!chunk) return null;
    try {
        const physicalOffset = chunks[chunk.ilsIndex]?.physicalOffset || chunk.physicalOffset;
        if (!physicalOffset) return null;

        const buf = Buffer.alloc(chunk.len);
        fs.readSync(fd, buf, 0, chunk.len, physicalOffset);

        let data = buf;
        // Robust decompression trail: zlib -> raw -> raw+offset
        if (chunk.compType === 1 || (chunk.uncompLen > 0 && chunk.uncompLen !== chunk.len)) {
            try {
                data = zlib.inflateSync(buf);
            } catch (e) {
                try {
                    data = zlib.inflateRawSync(buf);
                } catch (e2) {
                    // Fallback: If both fail, try scanning for Zlib header (0x78)
                    for (let i = 0; i < Math.min(buf.length, 128); i++) {
                        if (buf[i] === 0x78 && (buf[i + 1] === 0x01 || buf[i + 1] === 0x9C || buf[i + 1] === 0xDA)) {
                            try {
                                data = zlib.inflateSync(buf.slice(i));
                                break;
                            } catch (inner) { }
                        }
                    }
                    if (!data) data = buf;
                }
            }
        }
        return data;
    } catch (e) {
        logProxy('ERROR', `Failed to read/decompress chunk ${chunk.id}: ${e.message}`);
        return null;
    }
};

// Mock extractor for sub-extractors
const { castOrder = [], movieConfig = {}, resToMember = {} } = workerData;

const mockExtractor = {
    log: logProxy,
    options: workerOptions,
    castOrder,
    members: [], // Worker has no live member list; palette phase resolves before workers start
    metadataManager: {
        keyTable,
        nameTable,
        lctxMap,
        movieConfig,
        resToMember,
        resolvePaletteId(paletteId) {
            if (!paletteId) return null;

            const checkMember = (id) => {
                const map = keyTable[id];
                if (map && (map['CLUT'] || map['clut'] || map['Palt'] || map['palt'])) return id;
                return null;
            };

            // 1. Direct KeyTable Match
            let resolved = checkMember(paletteId);
            if (resolved) return resolved;

            // 2. Logical Slot Index via castOrder
            const minMember = movieConfig?.minMember ?? 1;
            const slotIndex = paletteId - minMember + 1;
            if (castOrder && slotIndex > 0 && slotIndex < castOrder.length) {
                resolved = checkMember(castOrder[slotIndex]);
                if (resolved) return resolved;
            }

            // 3. Direct Physical Slot Index
            if (castOrder && paletteId > 0 && paletteId < castOrder.length) {
                resolved = checkMember(castOrder[paletteId]);
                if (resolved) return resolved;
            }

            // 4. LctxMap fallback
            if (lctxMap[paletteId]) {
                const sectionId = lctxMap[paletteId];
                const memberId = resToMember[sectionId] || sectionId;
                resolved = checkMember(memberId);
                if (resolved) return resolved;
            }

            return null;
        }
    }
};

const bitmapExtractor = new BitmapExtractor(logProxy, mockExtractor);
const paletteExtractor = new PaletteExtractor(logProxy);
const textExtractor = new TextExtractor(logProxy);
const soundExtractor = new SoundExtractor(logProxy);
const scriptExtractor = new ScriptExtractor(logProxy);
const shapeExtractor = new ShapeExtractor(logProxy);
const fontExtractor = new FontExtractor(logProxy);
const vectorShapeExtractor = new VectorShapeExtractor(logProxy);
const movieExtractor = new MovieExtractor(logProxy);
const genericExtractor = new GenericExtractor(logProxy);
const lingoDecompiler = new LingoDecompiler(logProxy, mockExtractor);

if (chunks && chunks.length > 0) {
    logProxy('DEBUG', `[Worker] Chunk count: ${chunks.length}, ID range: ${chunks[0].id} to ${chunks[chunks.length - 1].id}`);
}

parentPort.on('message', async (task) => {
    const { member, outPathPrefix, palette, knownChecksum } = task;
    const memberId = member.id;

    try {
        const map = keyTable[memberId];
        const isScript = member.typeId === MemberType.Script;
        if (!map && !isScript) {
            logProxy('DEBUG', `Skipping phantom member ${memberId} (no keyTable entry)`);
            parentPort.postMessage({ type: 'DONE', id: memberId, checksum: null });
            return;
        }

        const sectionId = (map && (map[Magic.CAST] || map[Magic.CAS_STAR] || map[Magic.CAsT] || map[Magic.cast_lower] ||
            map[Magic.BITD] || map[Magic.ABMP] || map[Magic.STXT])) || (map ? Object.values(map)[0] : 0);

        let data = null;
        if (sectionId > 0) {
            const chunk = getChunkById(sectionId);
            if (!chunk) throw new Error(`Missing chunk ${sectionId} for member ${memberId}`);
            data = await getChunkData(chunk);
            if (!data) throw new Error(`Failed to read chunk data for ${memberId}`);
        }

        // [Incremental] Fast Content Hashing
        let contentHash = '';
        if (data) {
            const hash = crypto.createHash('sha256');
            hash.update(data);
            contentHash = hash.digest('hex');
        }

        if (knownChecksum) {
            logProxy('DEBUG', `[Worker] Member ${memberId} checksum check: content=${contentHash.substring(0, 8)}, known=${knownChecksum.substring(0, 8)}`);
        }

        if (knownChecksum && contentHash === knownChecksum && !workerOptions.force) {
            logProxy('DEBUG', `[Worker] SKIP signal for ${memberId}`);
            parentPort.postMessage({ type: 'SKIP', id: memberId });
            return;
        }

        let result = null;
        const typeId = member.typeId;

        if (typeId === MemberType.Bitmap) {
            let alphaData = null;
            if (map[Magic.ALFA]) {
                const alphaChunk = getChunkById(map[Magic.ALFA]);
                if (alphaChunk) alphaData = await getChunkData(alphaChunk);
            }
            result = await bitmapExtractor.extract(data, outPathPrefix + Resources.FileExtensions.PNG, member, palette, alphaData);
        } else if (typeId === MemberType.Sound) {
            result = await soundExtractor.save(data, outPathPrefix + Resources.FileExtensions.WAV, member);
        } else if (typeId === MemberType.Text || typeId === MemberType.Field) {
            const hasExt = (member.name || '').match(Resources.Regex.TextExtMatch);
            const ext = hasExt ? '' : '.rtf';
            result = await textExtractor.save(data, outPathPrefix + ext, member, { useRaw: !!hasExt });
        } else if (typeId === MemberType.Shape) {
            result = await shapeExtractor.save(outPathPrefix + Resources.FileExtensions.SVG, member, palette);
        } else if (typeId === MemberType.Font) {
            result = await fontExtractor.save(data, outPathPrefix + Resources.FileExtensions.Font);
        } else if (typeId === MemberType.VectorShape) {
            result = await vectorShapeExtractor.save(data, outPathPrefix + Resources.FileExtensions.SVG, member);
        } else if (typeId === MemberType.Palette) {
            result = await palette.process(data, memberId, chunks, fmap, workerOptions);
        } else if (typeId === MemberType.Script) {
            // Resolve correct Lscr ID using lctxMap mirroring ScriptHandler logic
            let lscrId = 0;
            if (member.scriptId > 0 && lctxMap[member.scriptId]) {
                lscrId = lctxMap[member.scriptId];
            } else if (memberId > 0 && lctxMap[memberId]) {
                lscrId = lctxMap[memberId];
            }

            logProxy('DEBUG', `[Worker] Script resolution for ${member.name} (id:${memberId}, scriptId:${member.scriptId}) -> lscrId:${lscrId}, sectionId:${sectionId}`);

            let scriptData = data;
            if (lscrId && lscrId !== sectionId) {
                const lscrChunk = chunks.find(c => c.id === lscrId);
                if (lscrChunk) {
                    scriptData = await getChunkData(lscrChunk);
                }
            }

            const decompiled = lingoDecompiler.decompile(scriptData, nameTable, member.scriptType || 0, memberId, workerOptions);
            const source = (typeof decompiled === 'object') ? decompiled.source : decompiled;
            if (source) {
                const outPath = outPathPrefix + Resources.FileExtensions.Script;
                fs.writeFileSync(outPath, source);
                if (workerOptions.lasm && decompiled.lasm) fs.writeFileSync(outPathPrefix + ".lasm", decompiled.lasm);
                const checksum = crypto.createHash('sha256').update(source).digest('hex');
                result = { format: Resources.Formats.LS, file: outPath, checksum };
            }
        } else if (typeId === MemberType.FilmLoop) {
            result = await movieExtractor.save(data, outPathPrefix + Resources.FileExtensions.JSON, member);
        } else {
            if (data && data.length > 0) {
                result = await genericExtractor.save(data, outPathPrefix + Resources.FileExtensions.Binary);
            }
        }

        // Final Response to main thread
        parentPort.postMessage({
            type: 'DONE',
            id: memberId,
            checksum: contentHash, // Use the calculated hash
            format: result?.format,
            scriptFile: result?.file || result?.path,
            width: result?.width,
            height: result?.height
        });
    } catch (e) {
        logProxy('ERROR', `Error for ${memberId}: ${e.message}`);
        parentPort.postMessage({ type: 'ERROR', id: memberId, message: e.message });
    }
});
