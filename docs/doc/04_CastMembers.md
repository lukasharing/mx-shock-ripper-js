# Cast Member Formats

Technical details on how specific cast member types are handled.

## Bitmaps (Type 1)
-   **Chunks**: `CASt` (Metadata) links to `BITD` (Image Data). Optional links to `ALFA` (Mask) and `CLUT` (Palette).
-   **Formats**: Supports 1, 2, 4, 8, 16, 24, 32-bit depths.
-   **Palettes**: 8-bit and lower images require a palette. The extractor resolves this via:
    1.  Member-specific palette (linked via `paletteId`).
    2.  System Palette (Mac/Win System 7).
    3.  Shared Palette (loaded from `shared_palettes.json`).

## Scripts (Type 11)
-   **Chunks**: `CASt` links to `Lscr` (Bytecode). `Lnam` (Names) and `Lctx` (Context) are global dependencies.
-   **Decompilation**: Bytecode is translated back to Lingo source using a custom decompiler (`LingoDecompiler.js`) based on Legacy Research logic.
-   **Output**: `.ls` files.

## Sounds (Type 6)
-   **Chunks**: `CASt` links to `SND ` (Standard) or `medi` (MP3/SWA).
-   **Formats**:
    -   **Standard**: Raw PCM samples. Wrapped in a WAV header during extraction.
    -   **MP3**: SWA compressed audio. Extracted as `.mp3`. The extractor validates the header to avoid corrupt files.

## Text (Type 3) & Fields (Type 13)
-   **Chunks**: `CASt` links to `STXT` (Styled Text) or `Field`.
-   **Handling**: Text content is decoded from MacRoman or UTF-8 and saved as raw text (or metadata within the JSON).
