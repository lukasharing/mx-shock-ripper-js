# Bitmap Extraction: Structure and Deterministic Algorithms

This document describes how `mx-shock-ripper-js` parses and converts Adobe Director bitmap (`BITD`) chunks into standard PNG files.

## Data Structure

Shockwave bitmaps are stored in several related segments:

- **BITD Chunk**: The primary container for pixel data. Can also be `DIB`, `Abmp`, or `PMBA` depending on format and protection.
- **Header**: Contains `rowBytes`, `width`, `height`, and `bitDepth`.
- **Palette**: Essential for indexed bitmaps (1, 2, 4, 8-bit) to map indices to RGB colors.
- **Alpha Channel**: 32-bit bitmaps may use a planar structure (A, R, G, B planes) or a separate alpha mask.

## Extraction Algorithm

The `BitmapExtractor` follows a deterministic approach to identify image dimensions and compression:

1. **Tag Resolution**: Scans for `BITD`, `DIB`, `DIB*`, `Abmp`, and `PMBA` tags to locate the most likely pixel data source.
2. **Metadata Analysis**: Checks member bit depth and compression flags (PackBits, Zlib, or Raw).
3. **Deterministic Size Matching**: Identifies padding and `rowBytes` by matching raw data size against expected dimensions.
4. **Decompression**:
    - **PackBits**: Handles standard RLE compression.
    - **Zlib/Deflate**: Handles modern compressed assets.
    - **Raw**: Processes uncompressed chunky or planar data.
5. **Normalization**: Reconstructs planar or chunky pixel data into a unified 32-bit ARGB buffer.
6. **PNG Generation**: Uses `pngjs` to produce optimized, transparent PNG output.

## Special Cases

- **Planar Reconstruction**: Handles both interleaved (row-by-row) and stacked (plane-by-plane) pixel distributions for high-depth assets.
