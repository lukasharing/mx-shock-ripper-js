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

const { fd, keyTable, nameTable, chunks, fmap, options: workerOptions, isAfterburned, ilsBodyOffset } = workerData;


const logProxy = (lvl, msg, memberId) => {
    parentPort.postMessage({ type: 'log', lvl, msg, memberId });
};

// Autonomous Data Accessor (Simplified version of DirectorFile logic for Worker)
const getChunkById = (id) => {
    const physicalId = (fmap && fmap[id] !== undefined) ? fmap[id] : id;
    return chunks.find(c => c.id === physicalId);
};

const getChunkData = async (chunk) => {
    if (!chunk) return null;
    try {
        const physicalOffset = chunk.physicalOffset;
        if (physicalOffset === undefined || physicalOffset < 0) {
            // Safety: offset -1 usually means it's an ILS chunk that didn't get mapped
            // We should not attempt to read it from FD as it will read from end of headers (incorrect)
            return null;
        }

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
const mockExtractor = {
    log: logProxy,
    options: workerOptions
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

parentPort.on('message', async (task) => {
    const { member, outPathPrefix, palette } = task;
    const memberId = member.id;

    try {
        const map = keyTable[memberId];
        if (!map) {
            logProxy('DEBUG', `Skipping phantom member ${memberId} (no keyTable entry)`);
            parentPort.postMessage({ type: 'result', memberId, result: null });
            return;
        }

        const sectionId = map[Magic.CAST] || map[Magic.CAS_STAR] || map[Magic.CAsT] || map[Magic.cast_lower] ||
            map[Magic.BITD] || map[Magic.ABMP] || map[Magic.STXT] || Object.values(map)[0];

        const chunk = getChunkById(sectionId);
        if (!chunk) throw new Error(`Missing chunk ${sectionId} for member ${memberId}`);

        const data = await getChunkData(chunk);
        if (!data) throw new Error(`Failed to read chunk data for ${memberId}`);

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
        } else if (typeId === MemberType.FilmLoop) {
            result = await movieExtractor.save(data, outPathPrefix + Resources.FileExtensions.JSON, member);
        } else if (typeId === MemberType.Script) {
            const decompiled = lingoDecompiler.decompile(data, nameTable, 0, memberId, workerOptions);
            const source = (typeof decompiled === 'object') ? decompiled.source : decompiled;
            if (source) {
                fs.writeFileSync(outPathPrefix + Resources.FileExtensions.Script, source);
                if (workerOptions.lasm && decompiled.lasm) fs.writeFileSync(outPathPrefix + ".lasm", decompiled.lasm);
                result = { format: Resources.Formats.LS, file: outPathPrefix + Resources.FileExtensions.Script };
            }
        } else {
            if (data && data.length > 0) {
                result = await genericExtractor.save(data, outPathPrefix + Resources.FileExtensions.Binary);
            }
        }

        if (result && (result.file || result.path)) {
            const outPath = result.path || path.join(path.dirname(outPathPrefix), result.file);
            if (fs.existsSync(outPath)) {
                const finalBuf = fs.readFileSync(outPath);
                result.checksum = crypto.createHash('sha256').update(finalBuf).digest('hex');
            }
        }

        parentPort.postMessage({ type: 'result', memberId, result });
    } catch (e) {
        parentPort.postMessage({ type: 'error', memberId, error: e.message, stack: e.stack });
    }
});
