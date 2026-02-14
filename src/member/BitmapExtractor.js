const zlib = require('zlib');
const { PNG } = require('pngjs');
const fs = require('fs');
const BaseExtractor = require('../extractor/BaseExtractor');
const DataStream = require('../utils/DataStream');
const { Bitmap, MemberType, HeaderSize } = require('../Constants');

const BitDepth = {
    Depth1: 1,
    Depth2: 2,
    Depth4: 4,
    Depth8: 8,
    Depth16: 16,
    Depth32: 32
};

class BitmapExtractor extends BaseExtractor {
    constructor(logger, extractor, compressionThreshold = 0) {
        super(logger);
        this.extractor = extractor;
        this.compressionThreshold = compressionThreshold;
    }

    async extract(bitmapBuf, outputPath, member, customPalette = null, alphaBuf = null) {
        if (!bitmapBuf || bitmapBuf.length === 0) return null;

        // 1. Geometry sets
        // Prioritize SPEC dimensions over Cast metadata dimensions for Habbo
        const dimSets = [];
        if (member._initialRect) {
            const r = member._initialRect;
            const w = Math.abs(r.right - r.left);
            const h = Math.abs(r.bottom - r.top);
            if (w > 0 && h > 0) dimSets.push({ w, h, source: 'Spec' });
        }
        const mw = member.width || 0;
        const mh = member.height || 0;
        if (mw > 0 && mh > 0 && (!dimSets[0] || dimSets[0].w !== mw || dimSets[0].h !== mh)) {
            dimSets.push({ w: mw, h: mh, source: 'Metadata' });
        }

        // 2. Decompression methods
        const zlibBuf = this._tryZlib(bitmapBuf);
        const methods = [
            { name: 'Raw', data: bitmapBuf },
            { name: 'PackBits', data: this.decodePackBits(bitmapBuf) },
            { name: 'Zlib', data: zlibBuf }
        ];
        if (zlibBuf && zlibBuf.length > 0) {
            methods.push({ name: 'Zlib+PackBits', data: this.decodePackBits(zlibBuf) });
        }

        const declaredDepth = member.bitDepth || 8;
        const depths = [32, 16, 8, 4, 1, 2];
        const orderedDepths = [declaredDepth, ...depths.filter(d => d !== declaredDepth)];
        const alignments = [1, 2, 4, 8, 16, 32, 64, 128];

        this.log('DEBUG', `[BitmapExtractor] ${member.name}: Starting robust trials. Compression=${member._compression}, DeclaredDepth=${declaredDepth}`);

        // 3. Robust Trial Loop
        // We prioritize the DECLARED depth as the outermost loop.
        // This prevents false matches at 4-bit when 8-bit PackBits decoded is the real intended result.
        for (const d of orderedDepths) {
            for (const method of methods) {
                if (!method.data || method.data.length === 0) continue;
                const actualLen = method.data.length;

                for (const dims of dimSets) {
                    const baseRowBytes = Math.ceil(dims.w * d / 8);
                    for (const align of alignments) {
                        const rb = Math.ceil(baseRowBytes / align) * align;
                        if (rb * dims.h === actualLen) {
                            this.log('SUCCESS', `[${method.name}] Match for ${member.name}: ${dims.w}x${dims.h}@${d} [${dims.source}], rowBytes=${rb}`);
                            return this._doExtract(method.data, dims.w, dims.h, d, rb, member, customPalette, alphaBuf, outputPath);
                        }
                    }
                }
            }
        }

        // 4. Special Case: Row-Based PackBits (Habbo legacy)
        // We also prioritize the declared depth here
        for (const d of orderedDepths) {
            for (const dims of dimSets) {
                const baseRowBytes = Math.ceil(dims.w * d / 8);
                for (const align of alignments) {
                    const rb = Math.ceil(baseRowBytes / align) * align;
                    // Try Row-Based PackBits on raw and zlib decompressed
                    const rowSources = [{ name: 'PackBitsRows', data: bitmapBuf }];
                    if (zlibBuf) rowSources.push({ name: 'PackBitsRows(Zlib)', data: zlibBuf });

                    for (const src of rowSources) {
                        const rowResult = this.decompressPackBitsRows(src.data, rb, dims.h);
                        if (rowResult && rowResult.actualLen > 0 && rowResult.data.length === rb * dims.h) {
                            this.log('SUCCESS', `[${src.name}] Match for ${member.name}: ${dims.w}x${dims.h}@${d} [${dims.source}], rowBytes=${rb}`);
                            return this._doExtract(rowResult.data, dims.w, dims.h, d, rb, member, customPalette, alphaBuf, outputPath);
                        }
                    }
                }
            }
        }

        this.log('ERROR', `No matching configuration found for ${member.name}. Tried all prioritized decompression/geometry combinations.`);
        return null;
    }


    async _doExtract(data, width, height, depth, rowBytes, member, customPalette, alphaBuf, outputPath) {
        if (!data || data.length === 0) return null;

        const { Palette } = require('../utils/Palette');
        const palette = customPalette || this.internalPalette || await Palette.resolveMemberPalette(member, this.extractor) ||
            (depth === 1 ? [[255, 255, 255], [0, 0, 0]] : null);

        let orders = ['DEFAULT'];
        if (depth === 32) {
            // ROW_PLANAR_ARGB has been verified as correct for Habbo 32-bit assets
            orders = ['ROW_PLANAR_ARGB'];
        }

        for (const order of orders) {
            try {
                const chunkyData = this._processChunkyData(data, width, height, depth, rowBytes, palette, alphaBuf, order);
                const dst = new PNG({ width, height, colorType: 6, inputHasAlpha: true });
                dst.data = chunkyData;
                const imgData = PNG.sync.write(dst);

                if (outputPath) {
                    return await this.saveFile(imgData, outputPath, "bitmap");
                }
                return imgData;
            } catch (e) {
                this.log('ERROR', `Extraction failed for ${member.name} (${order}): ${e.message}`);
            }
        }
        return null;
    }

    _tryZlib(buf) {
        try {
            return zlib.inflateSync(buf);
        } catch (e) {
            for (let i = 0; i < Math.min(buf.length, 128); i++) {
                if (buf[i] === 0x78 && (buf[i + 1] === 0x01 || buf[i + 1] === 0x9C || buf[i + 1] === 0xDA)) {
                    try {
                        return zlib.inflateSync(buf.slice(i));
                    } catch (inner) { }
                }
            }
        }
        return null;
    }

    _processChunkyData(pixelData, width, height, depth, rowBytes, palette, alphaBuf, channelOrder = 'ARGB') {
        const dst = Buffer.alloc(width * height * 4);

        if (!palette && depth <= 8) {
            palette = [];
            for (let i = 0; i < 256; i++) palette.push([i, i, i]);
        }

        if (depth === 32 && channelOrder.startsWith('ROW_PLANAR_')) {
            const layout = channelOrder.replace('ROW_PLANAR_', '');
            for (let y = 0; y < height; y++) {
                const rowBase = y * rowBytes;
                const planeWidth = Math.floor(rowBytes / 4);
                for (let x = 0; x < width; x++) {
                    const dstIdx = (y * width + x) * 4;
                    for (let c = 0; c < 4; c++) {
                        const char = layout[c];
                        const val = pixelData[rowBase + (planeWidth * c) + x] || 0;
                        if (char === 'R') dst[dstIdx] = val;
                        else if (char === 'G') dst[dstIdx + 1] = val;
                        else if (char === 'B') dst[dstIdx + 2] = val;
                        else if (char === 'A') dst[dstIdx + 3] = val;
                    }
                }
            }
            return dst;
        }

        if (depth === 32 && channelOrder.startsWith('PLANAR_')) {
            const layout = channelOrder.replace('PLANAR_', '');
            const planeSize = width * height;
            for (let i = 0; i < planeSize; i++) {
                const dstIdx = i * 4;
                for (let c = 0; c < 4; c++) {
                    const char = layout[c];
                    const val = pixelData[planeSize * c + i] || 0;
                    if (char === 'R') dst[dstIdx] = val;
                    else if (char === 'G') dst[dstIdx + 1] = val;
                    else if (char === 'B') dst[dstIdx + 2] = val;
                    else if (char === 'A') dst[dstIdx + 3] = val;
                }
            }
            return dst;
        }

        for (let y = 0; y < height; y++) {
            const rowStart = y * rowBytes;
            if (rowStart >= pixelData.length) break;
            for (let x = 0; x < width; x++) {
                let r = 0, g = 0, b = 0, a = 255;
                if (depth === 8) {
                    const colorIdx = pixelData[rowStart + x];
                    const color = (palette && palette[colorIdx]) || [0, 0, 0];
                    [r, g, b] = color;
                } else if (depth === 4) {
                    const byte = pixelData[rowStart + Math.floor(x / 2)];
                    const shift = (x % 2 === 0) ? 4 : 0;
                    const colorIdx = (byte >> shift) & 0x0F;
                    const color = (palette && palette[colorIdx]) || [0, 0, 0];
                    [r, g, b] = color;
                } else if (depth === 2) {
                    const byte = pixelData[rowStart + Math.floor(x / 4)];
                    const shift = (3 - (x % 4)) * 2;
                    const colorIdx = (byte >> shift) & 0x03;
                    const color = (palette && palette[colorIdx]) || [0, 0, 0];
                    [r, g, b] = color;
                } else if (depth === 1) {
                    const byte = pixelData[rowStart + Math.floor(x / 8)];
                    const bit = (byte >> (7 - (x % 8))) & 1;
                    const color = bit ? (palette[1] || [0, 0, 0]) : (palette[0] || [255, 255, 255]);
                    [r, g, b] = color;
                } else if (depth === 32) {
                    const idx = rowStart + x * 4;
                    if (idx + 3 < pixelData.length) {
                        const b1 = pixelData[idx], b2 = pixelData[idx + 1], b3 = pixelData[idx + 2], b4 = pixelData[idx + 3];
                        if (channelOrder === 'ARGB') { a = b1; r = b2; g = b3; b = b4; }
                        else if (channelOrder === 'RGBA') { r = b1; g = b2; b = b3; a = b4; }
                        else if (channelOrder === 'BGRA') { b = b1; g = b2; r = b3; a = b4; }
                    }
                } else if (depth === 16) {
                    const idx = rowStart + x * 2;
                    if (idx + 1 < pixelData.length) {
                        const val = pixelData.readUint16BE(idx);
                        r = ((val >> 10) & 0x1F) << 3; g = ((val >> 5) & 0x1F) << 3; b = (val & 0x1F) << 3;
                    }
                }
                if (alphaBuf && alphaBuf.length === width * height) a = alphaBuf[y * width + x];
                const dstIdx = (y * width + x) * 4;
                dst[dstIdx] = r; dst[dstIdx + 1] = g; dst[dstIdx + 2] = b; dst[dstIdx + 3] = a;
            }
        }
        return dst;
    }

    decompressPackBitsRows(data, rowBytes, height) {
        let inPos = 0;
        const out = Buffer.alloc(rowBytes * height);
        let outPos = 0;
        let actualLen = 0;
        try {
            for (let y = 0; y < height; y++) {
                if (inPos >= data.length) break;
                let rowDataLen = 0;
                if (data[inPos] > 120 && data[inPos] < 255) {
                    rowDataLen = data[inPos++];
                } else {
                    if (inPos + 2 > data.length) break;
                    rowDataLen = data.readUInt16BE(inPos);
                    inPos += 2;
                }
                if (inPos + rowDataLen > data.length) break;
                const rowEnd = inPos + rowDataLen;
                const rowStart = outPos;
                while (inPos < rowEnd && (outPos - rowStart) < rowBytes) {
                    const n = data.readInt8(inPos++);
                    if (n >= 0) {
                        const count = n + 1;
                        for (let i = 0; i < count && inPos < rowEnd && (outPos - rowStart) < rowBytes; i++) {
                            out[outPos++] = data[inPos++];
                            actualLen++;
                        }
                    } else if (n !== -128) {
                        const count = -n + 1;
                        if (inPos < rowEnd) {
                            const val = data[inPos++];
                            for (let i = 0; i < count && (outPos - rowStart) < rowBytes; i++) {
                                out[outPos++] = val;
                                actualLen++;
                            }
                        }
                    }
                }
                inPos = rowEnd;
                outPos = rowStart + rowBytes;
            }
            return { data: out, actualLen: actualLen };
        } catch (e) { return { data: out, actualLen: actualLen }; }
    }

    decodePackBits(data) {
        const out = [];
        let inPos = 0;
        try {
            while (inPos < data.length) {
                const n = data.readInt8(inPos++);
                if (n >= 0) {
                    const count = n + 1;
                    for (let i = 0; i < count && inPos < data.length; i++) out.push(data[inPos++]);
                } else if (n !== -128) {
                    const count = -n + 1;
                    if (inPos < data.length) {
                        const val = data[inPos++];
                        for (let i = 0; i < count; i++) out.push(val);
                    }
                }
            }
        } catch (e) { }
        return Buffer.from(out);
    }
}

module.exports = BitmapExtractor;
