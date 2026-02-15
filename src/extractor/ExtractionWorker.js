const { parentPort, workerData } = require('worker_threads');
const path = require('path');
const fs = require('fs');

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
const { MemberType, Magic } = require('../Constants');

/**
 * ExtractionWorker.js (Level 3 - Zero Contention)
 * Uses shared FD and metadata to perform autonomous Disk I/O.
 */

const { fd, keyTable, nameTable, chunks, options: workerOptions } = workerData;

const logProxy = (lvl, msg, memberId) => {
    parentPort.postMessage({ type: 'log', lvl, msg, memberId });
};

// Autonomous Data Accessor (Simplified version of DirectorFile logic for Worker)
const getChunkById = (id) => chunks.find(c => c.id === id);

const getChunkData = async (chunk) => {
    if (!chunk) return null;
    const buf = Buffer.alloc(chunk.size);
    fs.readSync(fd, buf, 0, chunk.size, chunk.offset);
    return buf;
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

        const sectionId = map[Magic.CAST] || map['CAS*'] || map['CAsT'] || map['cast'] ||
            map[Magic.BITD] || map['ABMP'] || map[Magic.STXT] || Object.values(map)[0];

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
            result = await bitmapExtractor.extract(data, outPathPrefix + ".png", member, palette, alphaData);
        } else if (typeId === MemberType.Sound) {
            result = await soundExtractor.save(data, outPathPrefix + ".wav", member);
        } else if (typeId === MemberType.Text || typeId === MemberType.Field) {
            const hasExt = (member.name || '').match(/\.(props|txt|json|xml|html|css|js|ls|lsc)$/i);
            const ext = hasExt ? '' : '.rtf';
            result = await textExtractor.save(data, outPathPrefix + ext, member, { useRaw: !!hasExt });
        } else if (typeId === MemberType.Shape) {
            result = await shapeExtractor.save(outPathPrefix + ".svg", member, palette);
        } else if (typeId === MemberType.Font) {
            result = await fontExtractor.save(data, outPathPrefix + ".fnt");
        } else if (typeId === MemberType.VectorShape) {
            result = await vectorShapeExtractor.save(data, outPathPrefix + ".svg", member);
        } else if (typeId === MemberType.FilmLoop) {
            result = await movieExtractor.save(data, outPathPrefix + ".json", member);
        } else if (typeId === MemberType.Script) {
            const decompiled = lingoDecompiler.decompile(data, nameTable, 0, memberId, workerOptions);
            const source = (typeof decompiled === 'object') ? decompiled.source : decompiled;
            if (source) {
                fs.writeFileSync(outPathPrefix + ".ls", source);
                if (workerOptions.lasm && decompiled.lasm) fs.writeFileSync(outPathPrefix + ".lasm", decompiled.lasm);
                result = { format: 'ls', file: outPathPrefix + ".ls" };
            }
        } else {
            if (data && data.length > 0) {
                result = await genericExtractor.save(data, outPathPrefix + ".dat");
            }
        }

        parentPort.postMessage({ type: 'result', memberId, result });
    } catch (e) {
        parentPort.postMessage({ type: 'error', memberId, error: e.message, stack: e.stack });
    }
});
