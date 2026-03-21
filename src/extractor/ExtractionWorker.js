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

const { fd, keyTable, nameTable, chunks, fmap, lctxMap, options: workerOptions, isAfterburned, ilsBodyOffset, ilsBody } = workerData;


const logProxy = (lvl, msg, memberId) => {
    parentPort.postMessage({ type: 'LOG', level: lvl, message: msg, memberId });
};

// Autonomous data accessor mirroring DirectorFile's canonical direct-id lookup.
// Later chunks (for example ABMP entries) overwrite earlier placeholders for the
// same resource id, which is the intended behavior for Afterburned files.
const chunkMap = new Map();
for (const chunk of chunks) {
    chunkMap.set(chunk.id, chunk);
}

const getChunkById = (id) => chunkMap.get(id) || null;
const isReadableChunk = (chunk) => !!(chunk && chunk.len > 0 && chunk.off >= 0);

const postSkip = (id, reason) => {
    parentPort.postMessage({ type: 'SKIP', id, reason });
};

const getChunkData = async (chunk) => {
    if (!isReadableChunk(chunk)) return null;
    try {
        const physicalOffset = chunk.physicalOffset;
        let buf;

        if (isAfterburned && chunk.isIlsResident && ilsBody) {
            const start = chunk.off;
            const end = start + chunk.len;
            if (start < 0 || end > ilsBody.length) {
                logProxy('ERROR', `Chunk ${chunk.id} ILS range [${start},${end}) out of bounds (ilsBody=${ilsBody.length})`);
                return null;
            }
            buf = ilsBody.slice(start, end);
        } else {
            buf = Buffer.allocUnsafe(chunk.len);
            const bytesRead = fs.readSync(fd, buf, 0, chunk.len, physicalOffset);
            if (bytesRead < chunk.len) {
                logProxy('WARN', `Truncated read for chunk ${chunk.id}: expected ${chunk.len}, got ${bytesRead}`);
                buf.fill(0, bytesRead);
            }
        }

        // Decompression: try standard inflate -> raw inflate -> scan for 0x78 (prefix-friendly)
        const isZlib = buf.length >= 2 && buf[0] === 0x78 && (buf[1] === 0x01 || buf[1] === 0x9c || buf[1] === 0xda);
        if (chunk.compType === 1 || (chunk.uncompLen > 0 && chunk.uncompLen !== chunk.len) || isZlib) {
            try {
                buf = zlib.inflateSync(buf);
            } catch (e) {
                try {
                    buf = zlib.inflateRawSync(buf);
                } catch (e2) {
                    // Fallback: Scan for Zlib header (0x78) with small prefix (Afterburner quirk)
                    let inflated = false;
                    for (let i = 1; i < Math.min(buf.length, 8); i++) {
                        if (buf[i] === 0x78 && (buf[i + 1] === 0x01 || buf[i + 1] === 0x9c || buf[i + 1] === 0xda)) {
                            try {
                                buf = zlib.inflateSync(buf.slice(i));
                                inflated = true;
                                break;
                            } catch (inner) { }
                        }
                    }
                }
            }
        }
        return buf;
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



parentPort.on('message', async (task) => {
    const { member, outPathPrefix, palette, knownChecksum } = task;
    const memberId = member.id;

    try {
        const map = keyTable[memberId];
        const isScript = member.typeId === MemberType.Script;
        if (!map && !isScript) {
            postSkip(memberId, 'unresolved_reference');
            return;
        }

        const sectionId = (map && (
            map[Magic.STXT] || map[Magic.stxt_lower] ||
            map[Magic.TEXT] || map[Magic.text_lower] ||
            map[Magic.BITD] || map[Magic.ABMP] || map[Magic.DIB] ||
            map[Magic.SND] || map[Magic.snd] || map[Magic.SND_STAR] ||
            map[Magic.CAST] || map[Magic.CAS_STAR] || map[Magic.CAsT] || map[Magic.cast_lower]
        )) || (map ? Object.values(map)[0] : 0);

        let data = null;
        if (sectionId > 0) {
            const chunk = getChunkById(sectionId);
            if (!chunk) {
                postSkip(memberId, 'unresolved_reference');
                return;
            }
            if (!isReadableChunk(chunk)) {
                postSkip(memberId, 'placeholder_source');
                return;
            }
            data = await getChunkData(chunk);
            if (!data) {
                postSkip(memberId, 'unresolved_reference');
                return;
            }
        }

        // [Incremental] Fast Content Hashing
        let contentHash = '';
        if (data) {
            if (!Buffer.isBuffer(data)) data = Buffer.from(data);
            if (!workerOptions.skipChecksum) {
                const hash = crypto.createHash('sha256');
                hash.update(data);
                contentHash = hash.digest('hex');
            }
        }


        if (knownChecksum && contentHash === knownChecksum && !workerOptions.force) {
            postSkip(memberId, 'unchanged');
            return;
        }

        let result = null;
        const typeId = member.typeId;

        if (typeId === MemberType.Bitmap) {
            let alphaData = null;
            if (map[Magic.ALFA]) {
                const alphaChunk = getChunkById(map[Magic.ALFA]);
                if (isReadableChunk(alphaChunk)) alphaData = await getChunkData(alphaChunk);
            }
            result = await bitmapExtractor.extract(data, outPathPrefix + Resources.FileExtensions.PNG, member, palette, alphaData);
        } else if (typeId === MemberType.Sound) {
            result = await soundExtractor.save(data, outPathPrefix + Resources.FileExtensions.WAV, member);
        } else if (typeId === MemberType.Text || typeId === MemberType.Field) {
            const hasExt = (member.name || '').match(Resources.Regex.TextExtMatch);
            const ext = hasExt ? '' : '.rtf';
            result = await textExtractor.save(data, outPathPrefix + ext, member, { useRaw: !!hasExt, chunkId: sectionId });
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


            let scriptData = data;
            if (lscrId && lscrId !== sectionId) {
                const lscrChunk = getChunkById(lscrId);
                if (isReadableChunk(lscrChunk)) {
                    scriptData = await getChunkData(lscrChunk);
                }
            }

            if (scriptData) scriptData = Buffer.from(scriptData);


            const resolvedNameTable = task.nameTable || nameTable;
            const decompiled = lingoDecompiler.decompile(scriptData, resolvedNameTable, member.scriptType || 0, memberId, workerOptions);
            const source = (typeof decompiled === 'object') ? decompiled.source : decompiled;
            if (source !== null && source !== undefined) {
                let finalName = member.name || `member_${memberId}`;
                let wasRenamed = false;


                if (/^member_\d+$/.test(finalName)) {
                    // 1. Try deterministic naming from LSCR header (factoryId) at offset 46
                    if (scriptData && scriptData.length >= 48) {
                        scriptData = Buffer.from(scriptData); // Ensure Buffer (ilsBody.slice may return Uint8Array)
                        const hLen = scriptData.readUInt16BE(16);
                        if (hLen >= 92) {
                            const factoryId = scriptData.readInt16BE(48);
                            if (factoryId >= 0 && nameTable[factoryId]) {
                                finalName = nameTable[factoryId];
                                wasRenamed = true;
                            }
                        }
                    }

                    // 2. Heuristic sniffing fallback (sniffing class variables)
                    // We give priority to class names found in source if they exist
                    const match = String(source).match(/["']([a-zA-Z0-9_.-]+\.class)["']/i);
                    if (match && match[1]) {
                        finalName = match[1];
                        wasRenamed = true;
                        logProxy('INFO', `Heuristic algorithm renamed anonymous ${member.name} -> ${finalName}`);
                    } else if (wasRenamed) {
                        logProxy('INFO', `Deterministic metadata renamed anonymous ${member.name} -> ${finalName}`);
                    }
                }

                const safeName = finalName.replace(/[/\\?%*:|"<>]/g, '_');
                const outDir = require('path').dirname(outPathPrefix);
                const outPath = require('path').join(outDir, `${safeName}.ls`);

                fs.writeFileSync(outPath, source);

                if (workerOptions.lasm && typeof decompiled === 'object' && decompiled.lasm) {
                    const lasmPath = require('path').join(outDir, `${safeName}.lasm`);
                    fs.writeFileSync(lasmPath, decompiled.lasm);
                }

                const checksum = crypto.createHash('sha256').update(source).digest('hex');
                result = {
                    format: Resources.Formats.LS,
                    file: path.basename(outPath),
                    path: outPath,
                    checksum,
                    renamed: wasRenamed ? finalName : undefined
                };
            }
        } else if (typeId === MemberType.FilmLoop) {
            result = await movieExtractor.save(data, outPathPrefix + Resources.FileExtensions.JSON, member);
        } else {
            if (data && data.length > 0) {
                const genericResult = await genericExtractor.save(data, outPathPrefix + Resources.FileExtensions.Binary);
                if (genericResult) {
                    result = {
                        ...genericResult,
                        format: Resources.Formats.DAT
                    };
                }
            }
        }

        const outcomeReason = result?.format
            ? undefined
            : (result?.reason || (data && data.length > 0 ? 'unsupported_content' : 'empty_asset'));

        // Final Response to main thread
        parentPort.postMessage({
            type: 'DONE',
            id: memberId,
            checksum: contentHash || result?.checksum || null,
            format: result?.format,
            scriptFile: result?.file || result?.path,
            width: result?.width,
            height: result?.height,
            renamed: result?.renamed,
            reason: outcomeReason
        });
    } catch (e) {
        logProxy('ERROR', `Error for ${memberId}: ${e.message}`);
        parentPort.postMessage({ type: 'ERROR', id: memberId, message: e.message });
    }
});
