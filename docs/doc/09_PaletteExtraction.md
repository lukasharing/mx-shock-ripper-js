# Palette Extraction: CLUT Parsing and Formats

This document describes the methods used by `mx-shock-ripper-js` to extract and convert Adobe Director palette (`CLUT`) assets.

## Data Structure

Director palettes are stored as Color Look-Up Tables (CLUT). Depending on the file version and source platform (Mac vs. Windows), they use different binary representations:

### 1. 16-bit Channel Format (Legacy)
In older files or Mac-originated assets, each color channel (Red, Green, Blue) is stored as a 16-bit big-endian integer. The lower 8 bits are usually zero or discarded during conversion to standard 24-bit RGB.
- **Entry Size**: 6 bytes per color.
- **Total Depth**: 256 colors = 1536 bytes.

### 2. 8-bit Channel Format (Modern)
Most modern Director files use standard 24-bit RGB (1 byte per channel).
- **Entry Size**: 3 bytes per color.
- **Total Depth**: 256 colors = 768 bytes.

### 3. RGBA / RGBX Format (Extended)
Some assets include a reserved fourth byte (alpha or padding).
- **Entry Size**: 4 bytes per color.
- **Total Depth**: 256 colors = 1024 bytes.

## Export Format: JASC-PAL

To ensure maximum compatibility with graphic tools (like PaintShop Pro, Photoshop, or custom game engines), palettes are exported in the **JASC-PAL** format. This is a simple plain-text format containing:
1. File signature (`JASC-PAL`)
2. Version header (`0100`)
3. Color count (`256`)
4. 256 lines of `R G B` space-separated values.
