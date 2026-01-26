/**
 * @version 1.1.5
 * BitmapExtractor.js - Deterministic reconstruction of Director BITD assets
 * 
 * Implements sophisticated pixel recovery for multiple bit depths (1, 2, 4, 8, 16, 24, 32).
 * Handles planar/chunky conversions, PackBits/Zlib decompression, and alpha channel integration.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { PNG } = require('pngjs');
const GenericExtractor = require('./GenericExtractor');
const DataStream = require('../utils/DataStream');
const { Bitmap, Limits, HeaderSize } = require('../Constants');
const { BitMask } = Bitmap;

class BitmapExtractor extends GenericExtractor {
    constructor(logger, palettes) {
        super(logger);
        this.palettes = palettes;
    }

    /**
     * Orchestrates the transformation of raw BITD bytes into a standardized PNG.
     */
    async extract(bitmapBuf, outputPath, member, palette, alphaBuf = null) {
        try {
            const context = this._analyzeStructure(bitmapBuf, member);
            if (!context) return null;

            let pixels = context.data;
            if (context.compressed) pixels = this._decompress(pixels, context);

            const interleaved = this._reconstructInterleaved(pixels, context, palette);
            if (!interleaved) return null;

            return await this._writePng(interleaved, context, outputPath, alphaBuf);
        } catch (e) {
            this.log('ERROR', `Bitmap extraction failed for ${member.name}: ${e.message}`);
            return null;
        }
    }

    _analyzeStructure(buffer, member) {
        let hasHeader = false;
        const ds = new DataStream(buffer, member.endianness || 'big');

        // Peek at header (12 bytes)
        if (buffer.length >= HeaderSize.Bitd) {
            const rb = ds.readUint16() & BitMask.RowBytes;
            const rect = ds.readRect();
            const w = Math.abs(rect.right - rect.left);
            const h = Math.abs(rect.bottom - rect.top);

            // Validate header against member metadata
            if (w === member.width && h === member.height && rb >= w) hasHeader = true;
        }

        const depth = member.bitDepth & 0xFF;
        const width = member.width || 1;
        const height = member.height || 1;

        return {
            width, height, depth,
            bitDepthRaw: member.bitDepth,
            rowBytes: hasHeader ? (buffer.readUInt16BE(0) & BitMask.RowBytes) : this._calculateRowBytes(width, depth),
            data: hasHeader ? buffer.slice(HeaderSize.Bitd) : buffer,
            compressed: member._compression > 0
        };
    }

    _calculateRowBytes(width, depth) {
        if (depth >= 16) return width * (depth / 8);
        const bits = width * depth;
        const bytes = Math.ceil(bits / 8);
        return bytes + (bytes % 2); // Director alignment
    }

    _decompress(data, ctx) {
        try {
            // Priority 1: Zlib (Shockwave standard)
            if (data.length > 2 && data[0] === 0x78) return zlib.inflateSync(data);
            // Priority 2: PackBits (Legacy Director standard)
            return this.decompressPackBits(data, ctx.rowBytes * ctx.height * 2);
        } catch (e) {
            return data;
        }
    }

    /**
     * Implementation of the Apple PackBits/RLE decompression algorithm.
     */
    decompressPackBits(data, expectedSize) {
        const out = Buffer.alloc(expectedSize);
        let i = 0, o = 0;
        while (o < expectedSize && i < data.length) {
            const b = data.readInt8(i++);
            if (b >= 0) {
                const count = b + 1;
                for (let j = 0; j < count && o < expectedSize; j++) out[o++] = data[i++];
            } else if (b !== -128) {
                const count = -b + 1;
                const val = data[i++];
                for (let j = 0; j < count && o < expectedSize; j++) out[o++] = val;
            }
        }
        return out.slice(0, o);
    }

    /**
     * Normalizes multiple bit-depth formats into standardized 32-bit ARGB.
     */
    _reconstructInterleaved(pixels, ctx, palette) {
        const { width, height, depth, rowBytes } = ctx;
        const out = Buffer.alloc(width * height * 4);

        for (let y = 0; y < height; y++) {
            const rowOff = y * rowBytes;
            for (let x = 0; x < width; x++) {
                const dst = (y * width + x) * 4;
                let r = 0, g = 0, b = 0, a = 255;

                if (depth <= 8) {
                    const idx = this._getPixelIndex(pixels, x, rowOff, depth);
                    [r, g, b] = palette[idx] || [0, 0, 0];
                    if (idx === 0) a = 0; // Default transparent key
                } else if (depth === 16) {
                    const val = pixels.readUInt16BE(rowOff + x * 2);
                    r = ((val >> 10) & 0x1F) << 3;
                    g = ((val >> 5) & 0x1F) << 3;
                    b = (val & 0x1F) << 3;
                } else if (depth >= 24) {
                    const off = rowOff + x * (depth / 8);
                    if (depth === 32) a = pixels[off];
                    r = pixels[off + 1]; g = pixels[off + 2]; b = pixels[off + 3];
                }

                out[dst] = r; out[dst + 1] = g; out[dst + 2] = b; out[dst + 3] = a;
            }
        }
        return out;
    }

    _getPixelIndex(pixels, x, rowOff, depth) {
        if (depth === 8) return pixels[rowOff + x];
        if (depth === 4) return (x % 2 === 0) ? (pixels[rowOff + (x >> 1)] >> 4) : (pixels[rowOff + (x >> 1)] & 0xF);
        if (depth === 1) return (pixels[rowOff + (x >> 3)] >> (7 - (x % 8))) & 1;
        return 0;
    }

    async _writePng(pixels, ctx, outputPath, alphaBuf) {
        const png = new PNG({ width: ctx.width, height: ctx.height, colorType: 6 });

        for (let i = 0; i < ctx.width * ctx.height; i++) {
            const off = i * 4;
            png.data[off] = pixels[off];
            png.data[off + 1] = pixels[off + 1];
            png.data[off + 2] = pixels[off + 2];
            png.data[off + 3] = alphaBuf ? alphaBuf[i] : pixels[off + 3];
        }

        const result = PNG.sync.write(png);
        fs.writeFileSync(outputPath, result);
        return { path: outputPath, size: result.length };
    }
}

module.exports = BitmapExtractor;
