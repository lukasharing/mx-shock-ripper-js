# Cast Member Formats

Technical details on how specific cast member types are handled and extracted.

## Bitmaps (Type 1)
-   **Chunks**: `CASt` (Metadata) links to `BITD` (Image Data). Optional links to `ALFA` (Mask) and `CLUT` (Palette).
-   **Formats**: Supports 1, 2, 4, 8, 16, 24, 32-bit depths.
-   **Extraction**: Always converted to **`.png`**.
-   **Palettes**: 8-bit and lower images require a palette. The extractor resolves this via:
    1.  Member-specific palette (linked via `paletteId`).
    2.  System Palette (Mac/Win System 7).
    3.  Shared Palette (loaded from `shared_palettes.json`).

## Scripts (Type 11)
-   **Chunks**: `CASt` links to `Lscr` (Bytecode). `Lnam` (Names) and `Lctx` (Context).
-   **Decompilation**: Bytecode is translated back to Lingo source using `LingoDecompiler.js`.
-   **Extraction**: Always saves **`.lsc`** (Compiled Bytecode). Also saves **`.ls`** (Lingo Source) if decompilation succeeds.

## Sounds (Type 6)
-   **Chunks**: `CASt` links to `SND ` (Standard) or `medi` (MP3/SWA).
-   **Extraction**:
    -   **Standard**: Raw PCM samples. Saved as **`.wav`**.
    -   **MP3/SWA**: Compressed audio. Saved as **`.mp3`**.

## Text (Type 3) & Fields (Type 13)
-   **Chunks**: `CASt` links to `STXT` (Styled Text) or `Field`.
-   **Extraction**: Saved as **`.rtf`** to preserve formatting.

## Shapes (Type 2) & Vector Shapes (Type 18)
-   **Shapes (QuickDraw)**: Simple geometric primitives (Type 2). Extracted as **`.svg`**.
-   **Vector Shapes**: Complex Flash-like vectors (Type 18). Extracted as **`.dat`** (Raw Binary) due to lack of parsing logic.

## Palettes (Type 4)
-   **Chunks**: `CASt` links to `CLUT`.
-   **Extraction**: Saved as **`.pal`** (JASC-PAL format).

## FilmLoops (Type 2)
-   **Chunks**: `CASt` links to `Score` / `VWSc`.
-   **Extraction**: Saved as **`.filmloop.json`** containing the internal score data.

## Fonts (Type 16)
-   **Chunks**: `CASt` links to `FONT` / `VWFT`.
-   **Extraction**: Saved as **`.ttf`** or **`.otf`** if standard, otherwise proprietary **`.font`**.
