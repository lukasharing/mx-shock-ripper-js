# Bitmap Extraction: Structure and Deterministic Algorithms

This document describes how `mx-shock-ripper-js` parses and converts Adobe Director bitmap (`BITD`) chunks into standard PNG files.

## Data Structure

Shockwave bitmaps are stored in several related segments:

- **BITD Chunk**: The primary container for pixel data. It may or may not include a 12-byte header depending on the Director version and compression type.
- **Header**: Contains `rowBytes`, `width`, `height`, and `bitDepth`.
- **Palette**: Essential for indexed bitmaps (1, 2, 4, 8-bit) to map indices to RGB colors.
- **Alpha Channel**: 32-bit bitmaps may use a planar structure (A, R, G, B planes) or a separate alpha mask.

## Extraction Algorithm

The `BitmapExtractor` follows a deterministic approach to identify image dimensions and compression:

1. **Metadata Analysis**: Checks member bit depth and compression flags (PackBits, Zlib, or Raw).
2. **Deterministic Size Matching**: Identifies padding and `rowBytes` by matching raw data size against expected dimensions.
3. **Decompression**:
    - **PackBits**: Handles standard RLE compression.
    - **Zlib/Deflate**: Handles modern compressed assets.
    - **Raw**: Processes uncompressed chunky or planar data.
4. **Normalization**: Reconstructs planar or chunky pixel data into a unified 32-bit ARGB buffer.
5. **PNG Generation**: Uses `pngjs` to produce optimized, transparent PNG output.

## Special Cases

- **Habbo 8208 (0x2010)**: A frequent edge case in Habbo Hotel assets where 8-bit indexed images are marked with a specific flag.
- **Planar Reconstruction**: Handles both interleaved (row-by-row) and stacked (plane-by-plane) pixel distributions for high-depth assets.
