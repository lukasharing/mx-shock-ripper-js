const GenericExtractor = require('./GenericExtractor');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { PNG } = require('pngjs');
const DataStream = require('../utils/DataStream');
const { Bitmap, Limits, HeaderSize } = require('../Constants');
const { BitMask, BitDepth: BitDepthArray, BitmapFlags, Alpha } = Bitmap;

// Add named constants for compatibility with stable BitmapExtractor
const BitDepth = {
    Depth1: 1, Depth2: 2, Depth4: 4, Depth8: 8,
    Depth16: 16, Depth24: 24, Depth32: 32, BitsPerByte: 8
};
// Extend Alpha with BytesPerPixel
if (!Alpha.BytesPerPixel) Alpha.BytesPerPixel = 4;

/**
 * @version 1.2.2
 * BitmapExtractor - Deterministic Shockwave Director bitmap (BITD) 
 * parsing and PNG conversion.
 * 
 * See docs/doc/06_BitmapExtraction.md for technical details.
 */
class BitmapExtractor extends GenericExtractor {
    constructor(logger, palettes, fileVersion) {
        super(logger);
        this.palettes = palettes;
        this.fileVersion = fileVersion;
        this.internalPalette = null;
    }

    setInternalPalette(palette) {
        this.internalPalette = palette;
    }

    // Compatibility wrapper - DirectorExtractor calls extract() but this class uses save()
    async extract(bitmapBuf, outputPath, member, palette, alphaBuf = null) {
        const castRect = { top: 0, left: 0, bottom: member.height || 0, right: member.width || 0 };
        return await this.save(bitmapBuf, castRect, outputPath, member, member.endianness || 'big', alphaBuf, palette);
    }

    /**
     * Reconstructs interleaved or stacked planar pixel data into a chunky ARGB buffer.
     * @private
     */
    _reconstructPlanar(pixelData, width, height, rowBytes, depth, numPlanes, palette) {
        const interleaved = this._reconstructPlanarInternal(pixelData, width, height, rowBytes, depth, numPlanes, palette, true);
        const stacked = this._reconstructPlanarInternal(pixelData, width, height, rowBytes, depth, numPlanes, palette, false);
        const isExactlyInterleaved = (rowBytes === width * numPlanes);
        if (isExactlyInterleaved && interleaved) return interleaved;
        return stacked || interleaved;
    }

    _reconstructPlanarInternal(pixelData, width, height, rowBytes, depth, numPlanes, palette, interleaved) {
        try {
            const chunky = Buffer.alloc(width * height * Alpha.BytesPerPixel);
            const planeSize = width * height;
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    const dstOff = (y * width + x) * Alpha.BytesPerPixel;
                    let r, g, b, a = Alpha.Opaque;
                    if (interleaved) {
                        const rowOff = y * rowBytes;
                        if (rowOff + x + width * (numPlanes - 1) >= pixelData.length) continue;
                        if (numPlanes === 4) {
                            [a, r, g, b] = [pixelData[rowOff + x], pixelData[rowOff + x + width], pixelData[rowOff + x + width * 2], pixelData[rowOff + x + width * 3]];
                        } else if (numPlanes === 3) {
                            [r, g, b] = [pixelData[rowOff + x], pixelData[rowOff + x + width], pixelData[rowOff + x + width * 2]];
                        } else if (numPlanes === 2) {
                            a = pixelData[rowOff + x];
                            [r, g, b] = palette[pixelData[rowOff + x + width]] || [0, 0, 0];
                        }
                    } else {
                        const off = y * width + x;
                        if (off + planeSize * (numPlanes - 1) >= pixelData.length) continue;
                        if (numPlanes === 4) {
                            [a, r, g, b] = [pixelData[off], pixelData[off + planeSize], pixelData[off + planeSize * 2], pixelData[off + planeSize * 3]];
                        } else if (numPlanes === 3) {
                            [r, g, b] = [pixelData[off], pixelData[off + planeSize], pixelData[off + planeSize * 2]];
                        } else if (numPlanes === 2) {
                            a = pixelData[off];
                            [r, g, b] = palette[pixelData[off + planeSize]] || [0, 0, 0];
                        }
                    }
                    chunky[dstOff + 0] = r || 0;
                    chunky[dstOff + 1] = g || 0;
                    chunky[dstOff + 2] = b || 0;
                    chunky[dstOff + 3] = (a !== undefined) ? a : Alpha.Opaque;
                }
            }
            return { pixelData: chunky, bitdHeight: height, rowBytes: width * Alpha.BytesPerPixel, depth: BitDepth.Depth32 };
        } catch (e) { return null; }
    }

    /**
     * Normalizes indexed or high-depth pixel data into a 32-bit ARGB buffer.
     * @private
     */
    _normalizeToARGB(pixelData, width, height, rowBytes, depth, palette, noTransparency) {
        const chunky = Buffer.alloc(width * height * Alpha.BytesPerPixel);
        const ds = new DataStream(pixelData, 'big');
        const readSafe = () => (ds.position < pixelData.length) ? ds.readUint8() : 0;

        // Use Color.getGrayscale() if palette is missing and depth is 8
        const effectivePalette = (depth === 8 && (!palette || palette.length === 0)) ? this.palettes.getGrayscale() : palette;

        for (let y = 0; y < height; y++) {
            ds.seek(y * (rowBytes || Math.ceil((width * depth) / BitDepth.BitsPerByte)));
            for (let x = 0; x < width; x++) {
                const dstIdx = (y * width + x) * Alpha.BytesPerPixel;
                if (depth === 1) {
                    const bytePos = (y * rowBytes) + Math.floor(x / 8);
                    const byteVal = (bytePos < pixelData.length) ? pixelData[bytePos] : 0;
                    const val = (byteVal >> (7 - (x % 8))) & 1;
                    const color = effectivePalette[val] || [0, 0, 0];
                    const alpha = (val === 0 && !noTransparency) ? Alpha.Transparent : Alpha.Opaque;
                    [chunky[dstIdx], chunky[dstIdx + 1], chunky[dstIdx + 2], chunky[dstIdx + 3]] = [...color, alpha];
                } else if (depth === 2) {
                    const bytePos = (y * rowBytes) + Math.floor(x / 4);
                    const byteVal = (bytePos < pixelData.length) ? pixelData[bytePos] : 0;
                    const val = (byteVal >> (6 - (x % 4) * 2)) & 0x03;
                    const color = effectivePalette[val] || [0, 0, 0];
                    const alpha = (val === 0 && !noTransparency) ? Alpha.Transparent : Alpha.Opaque;
                    [chunky[dstIdx], chunky[dstIdx + 1], chunky[dstIdx + 2], chunky[dstIdx + 3]] = [...color, alpha];
                } else if (depth === 4) {
                    const bytePos = (y * rowBytes) + Math.floor(x / 2);
                    const byteVal = (bytePos < pixelData.length) ? pixelData[bytePos] : 0;
                    const val = (byteVal >> (4 - (x % 2) * 4)) & 0x0F;
                    const color = effectivePalette[val] || [0, 0, 0];
                    const alpha = (val === 0 && !noTransparency) ? Alpha.Transparent : Alpha.Opaque;
                    [chunky[dstIdx], chunky[dstIdx + 1], chunky[dstIdx + 2], chunky[dstIdx + 3]] = [...color, alpha];
                } else if (depth === BitDepth.Depth32) {
                    const [a, r, g, b] = [readSafe(), readSafe(), readSafe(), readSafe()];
                    [chunky[dstIdx], chunky[dstIdx + 1], chunky[dstIdx + 2], chunky[dstIdx + 3]] = [r, g, b, a];
                } else if (depth === BitDepth.Depth24) {
                    const [r, g, b] = [readSafe(), readSafe(), readSafe()];
                    [chunky[dstIdx], chunky[dstIdx + 1], chunky[dstIdx + 2], chunky[dstIdx + 3]] = [r, g, b, Alpha.Opaque];
                } else {
                    const palIdx = readSafe();
                    const color = effectivePalette[palIdx] || [0, 0, 0];
                    const alpha = (palIdx === 0 && !noTransparency) ? Alpha.Transparent : Alpha.Opaque;
                    [chunky[dstIdx], chunky[dstIdx + 1], chunky[dstIdx + 2], chunky[dstIdx + 3]] = [...color, alpha];
                }
            }
        }
        return chunky;
    }

    /**
     * Checks if the corners of an indexed bitmap are transparent (index 0).
     * @private
     */
    _checkIsTransparentCanvas(pixelData, width, height, rowBytes, depth) {
        if (depth > BitDepth.Depth8) return false;
        const getIndex = (x, y) => {
            const rb = rowBytes || Math.ceil((width * depth) / BitDepth.BitsPerByte);
            const pos = (y * rb);
            if (depth === BitDepth.Depth8) return pixelData[pos + x];
            if (depth === BitDepth.Depth4) { const b = pixelData[pos + Math.floor(x / 2)]; return (x % 2 === 0) ? (b >> 4) : (b & 0x0F); }
            if (depth === BitDepth.Depth2) { const b = pixelData[pos + Math.floor(x / 4)]; return (b >> (6 - (x % 4) * 2)) & 0x03; }
            if (depth === BitDepth.Depth1) { const b = pixelData[pos + Math.floor(x / 8)]; return (b >> (7 - (x % 8))) & 1; }
            return 0;
        };
        try {
            const corners = [getIndex(0, 0), getIndex(width - 1, 0), getIndex(0, height - 1), getIndex(width - 1, height - 1)];
            return corners.every(c => c === 0);
        } catch (e) { return false; }
    }

    /**
     * Standard PackBits decompression algorithm.
     */
    decompressPackBits(data, expectedSize) {
        const output = Buffer.alloc(expectedSize);
        let outIdx = 0, inIdx = 0;
        while (outIdx < expectedSize && inIdx < data.length) {
            let b = data.readInt8(inIdx++);
            if (b >= 0) {
                let count = b + 1;
                for (let i = 0; i < count && outIdx < expectedSize; i++) output[outIdx++] = data[inIdx++];
            } else if (b !== -128) {
                let count = -b + 1;
                let val = data[inIdx++];
                for (let i = 0; i < count && outIdx < expectedSize; i++) output[outIdx++] = val;
            }
        }
        return output.slice(0, outIdx);
    }

    async save(bitmapBuf, castRect, outputPath, member, endianness, alphaBuf = null, customPalette = null) {
        let shouldRotate = false;
        try {
            // 1. Parse or calculate header metadata
            const header = this._parseHeader(bitmapBuf, endianness, member, castRect);
            if (!header) return null;

            if (bitmapBuf.length <= header.startData) {
                this.log('WARNING', `Bitmap ${member.name} (${member.id}) has header but zero pixel data. Skipping.`);
                return null;
            }

            // 2. Extract and decompress pixel data
            const pixelData = this._getPixelData(bitmapBuf, header, member);
            if (!pixelData) return null;

            // 3. Select appropriate palette
            const palette = customPalette || this.internalPalette ||
                (header.depth === BitDepth.Depth1 ? [[255, 255, 255], [0, 0, 0]] : this.palettes.getGrayscale());

            // 4. Normalize pixel data to ARGB/Chunky format
            const chunkyData = this._processChunkyData(pixelData, header, member, palette, alphaBuf);
            if (!chunkyData) return null;

            // 5. Generate and save PNG
            const outputWidth = shouldRotate ? header.height : header.width;
            const outputHeight = shouldRotate ? header.width : header.height;
            const dst = new PNG({ width: outputWidth, height: outputHeight, colorType: 6, inputHasAlpha: true });

            let isEmpty = true;
            for (let y = 0; y < header.height; y++) {
                for (let x = 0; x < header.width; x++) {
                    const srcIdx = (y * header.width + x) * 4;
                    let dstX = x, dstY = y;
                    if (shouldRotate) { dstX = header.height - 1 - y; dstY = x; }
                    const dstIdx = (dstY * outputWidth + dstX) * 4;

                    if (srcIdx + 3 < chunkyData.length && dstIdx + 3 < dst.data.length) {
                        dst.data[dstIdx] = chunkyData[srcIdx];
                        dst.data[dstIdx + 1] = chunkyData[srcIdx + 1];
                        dst.data[dstIdx + 2] = chunkyData[srcIdx + 2];
                        dst.data[dstIdx + 3] = alphaBuf ? alphaBuf[y * header.width + x] : chunkyData[srcIdx + 3];
                        if (dst.data[dstIdx + 3] > 0) isEmpty = false;
                    }
                }
            }

            if (!isEmpty) {
                const imgData = PNG.sync.write(dst);
                const result = this.saveFile(imgData, outputPath, "bitmap");
                if (result) return { width: outputWidth, height: outputHeight, path: result.file };
            }
            return null;
        } catch (e) {
            this.log('ERROR', `Failed to save bitmap ${member.name}: ${e.stack}`);
            return null;
        }
    }

    /**
     * Extracts structural metadata from the BITD chunk header or member properties.
     */
    _parseHeader(buffer, endianness, member, castRect) {
        let hasHeader = false;
        if (buffer.length >= HeaderSize.Bitd) {
            const bds = new DataStream(buffer, endianness);
            const rbRaw = (endianness === 'little') ? bds.buffer.readUInt16LE(0) : bds.buffer.readUInt16BE(0);
            const top = (endianness === 'little') ? bds.buffer.readInt16LE(2) : bds.buffer.readInt16BE(2);
            const left = (endianness === 'little') ? bds.buffer.readInt16LE(4) : bds.buffer.readInt16BE(4);
            const bottom = (endianness === 'little') ? bds.buffer.readInt16LE(6) : bds.buffer.readInt16BE(6);
            const right = (endianness === 'little') ? bds.buffer.readInt16LE(8) : bds.buffer.readInt16BE(8);
            const rb = rbRaw & BitMask.RowBytes;
            const w = Math.abs(right - left), h = Math.abs(bottom - top);
            const castWidth = member.width || Math.abs(castRect.right - castRect.left);
            const castHeight = member.height || Math.abs(castRect.bottom - castRect.top);

            if (w === castWidth && h === castHeight && rb >= w && rb < w + Limits.RowBytesPaddingThreshold) hasHeader = true;
            else if (w > 0 && w < Limits.MaxImageDimension && h > 0 && h < Limits.MaxImageDimension && rb >= w && rb < w + Limits.ExtendedRowBytesPaddingThreshold) hasHeader = true;
        }

        const rawDepth = member.bitDepth || BitDepth.Depth8;
        let nominalDepth = (rawDepth & 0xFF);
        if (rawDepth === 8208) nominalDepth = 8;

        let width, height, rowBytes, startData;
        if (hasHeader) {
            const rbRaw = (endianness === 'little') ? buffer.readUInt16LE(0) : buffer.readUInt16BE(0);
            const bTop = (endianness === 'little') ? buffer.readInt16LE(2) : buffer.readInt16BE(2);
            const bLeft = (endianness === 'little') ? buffer.readInt16LE(4) : buffer.readInt16BE(4);
            const bBottom = (endianness === 'little') ? buffer.readInt16LE(6) : buffer.readInt16BE(6);
            const bRight = (endianness === 'little') ? buffer.readInt16BE(8) : buffer.readInt16BE(8);
            rowBytes = rbRaw & BitMask.RowBytes;
            width = Math.abs(bRight - bLeft);
            height = Math.abs(bBottom - bTop);
            startData = HeaderSize.Bitd;
        } else {
            width = member.width || Math.abs(castRect.right - castRect.left);
            height = member.height || Math.abs(castRect.bottom - castRect.top);
            rowBytes = (nominalDepth === BitDepth.Depth32) ? (width * Alpha.BytesPerPixel) : (width + (width % 2));
            startData = 0;
        }

        return { width: width || 1, height: height || 1, rowBytes, depth: nominalDepth, startData, hasHeader, rawDepth };
    }

    /**
     * Resolves and decompresses pixel data based on compression flags.
     */
    _getPixelData(buffer, header, member) {
        let pixelData = buffer.slice(header.startData);
        if (header.hasHeader) return pixelData;

        const { width, height, depth } = header;
        let calcRowBytes;
        if (depth <= BitDepth.Depth8) {
            const bitsPerRow = width * depth;
            const bytesPerRow = Math.ceil(bitsPerRow / 8);
            calcRowBytes = bytesPerRow + (bytesPerRow % 2);
        } else if (header.depth === BitDepth.Depth16) calcRowBytes = width * 2;
        else if (header.depth === BitDepth.Depth24) calcRowBytes = width * 3;
        else if (header.depth === BitDepth.Depth32) calcRowBytes = width * 4;
        else calcRowBytes = width + (width % 2);

        const expectedSize = calcRowBytes * height;

        // Path 1: Raw / Uncompressed
        if (pixelData.length === expectedSize || Math.abs(pixelData.length - expectedSize) <= 2) {
            header.rowBytes = calcRowBytes;
            return pixelData;
        }

        // Path 2: PackBits
        if ([1, 0xFFFE, 202, -101, 0xFF9B].some(c => member._compression === c || (member._compression & 0xFFFF) === c)) {
            let pData = pixelData;
            if (member._compression === 202 && pixelData.length > 4 && pixelData[0] === 0xC8) pData = pixelData.slice(4);
            const decompressed = this.decompressPackBits(pData, expectedSize * 1.5 + 100);
            if (decompressed.length === expectedSize || Math.abs(decompressed.length - expectedSize) <= 2) {
                header.rowBytes = calcRowBytes;
                return decompressed;
            }
        }

        // Path 3: Zlib / Deflate
        if (member._compression === 315 || pixelData.length < expectedSize) {
            let decompressed = null;
            try {
                let zData = pixelData;
                if (member._compression === 315 && pixelData.length > 4 && pixelData[0] === 0xC8) zData = pixelData.slice(4);
                decompressed = zlib.inflateSync(zData);
            } catch (e) {
                try { decompressed = this.decompressPackBits(pixelData, expectedSize * 2); } catch (e2) { }
            }

            if (decompressed && (decompressed.length === expectedSize || Math.abs(decompressed.length - expectedSize) <= 2)) {
                header.rowBytes = calcRowBytes;
                return decompressed;
            }
        }

        // Path 4: Unpadded fallback
        if (depth <= 8) {
            const unpaddedRowBytes = Math.ceil((width * depth) / 8);
            const unpaddedSize = unpaddedRowBytes * height;
            if (pixelData.length === unpaddedSize) {
                header.rowBytes = unpaddedRowBytes;
                return pixelData;
            }
        }

        this.log('ERROR', `Data size mismatch (Got: ${pixelData.length}) for ${width}x${height}@${depth}`);
        return null;
    }

    /**
     * Converts raw pixels into 32-bit chunky ARGB data.
     */
    _processChunkyData(pixelData, header, member, palette, alphaBuf) {
        let chunkyData;
        const { width, height, rowBytes, depth, rawDepth } = header;
        const forceOpaque = (rawDepth & 0x4000) !== 0;
        const numPlanes = (depth === 32) ? 4 : ((depth === 24) ? 3 : ((depth === 16) ? 2 : 0));
        const isProbablyPlanar = (numPlanes >= 3) || (numPlanes === 2 && rowBytes === width);

        if (numPlanes > 1 && isProbablyPlanar) {
            const planRes = this._reconstructPlanar(pixelData, width, height, rowBytes, depth, numPlanes, palette);
            if (planRes) {
                chunkyData = planRes.pixelData;
                if (!forceOpaque && numPlanes === 4) {
                    let hasActionableAlpha = false, firstAlpha = chunkyData[3];
                    for (let i = 3; i < chunkyData.length; i += 4) if (chunkyData[i] !== firstAlpha) { hasActionableAlpha = true; break; }
                    if (!hasActionableAlpha) for (let i = 3; i < chunkyData.length; i += 4) chunkyData[i] = 255;
                }
                return chunkyData;
            }
        }

        if (depth === 16) {
            chunkyData = Buffer.alloc(width * height * 4);
            const endianness = member.endianness || 'big';
            for (let i = 0; i < width * height; i++) {
                const srcOff = i * 2;
                if (srcOff + 1 >= pixelData.length) break;
                const val = endianness === 'big' ? pixelData.readUInt16BE(srcOff) : pixelData.readUInt16LE(srcOff);
                const r = ((val >> 10) & 0x1F) << 3;
                const g = ((val >> 5) & 0x1F) << 3;
                const b = (val & 0x1F) << 3;
                let a = (rawDepth & 0x4000) ? ((val & 0x8000) ? 255 : 0) : 255;
                [chunkyData[i * 4], chunkyData[i * 4 + 1], chunkyData[i * 4 + 2], chunkyData[i * 4 + 3]] = [r, g, b, a];
            }
        } else {
            // Refined transparency logic: 
            // 1. If forceOpaque (AlphaChannelUsed flag NOT set for 16/32bit), no transparency.
            // 2. If it's a "transparent canvas" (corners are index 0), enable transparency.
            // 3. For 8-bit or less, we often want index 0 to be transparent unless it's a matte or opaque member.
            const isTransparentCanvas = !forceOpaque && depth <= 8 && this._checkIsTransparentCanvas(pixelData, width, height, rowBytes, depth);
            const noTransparencyOverride = forceOpaque || (depth > 8 && !isTransparentCanvas && !(rawDepth & 0x4000));

            chunkyData = this._normalizeToARGB(pixelData, width, height, rowBytes, depth, palette, noTransparencyOverride);
        }

        if (forceOpaque && depth > 8) {
            for (let i = 3; i < chunkyData.length; i += 4) chunkyData[i] = 255;
        }

        return chunkyData;
    }
}

module.exports = BitmapExtractor;
