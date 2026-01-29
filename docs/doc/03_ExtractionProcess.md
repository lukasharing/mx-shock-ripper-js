# Extraction Process

This document outlines the step-by-step logic executed by `DirectorExtractor` to turn a binary file into assets.

## 1. Initialization
-   **Input**: The path to a `.dcr` or `.cct` file.
-   **Parsing**: The file is read into a buffer and parsed by `DirectorFile`. This builds a list of Chunk headers.
-   **Validation**: The file signature (`RIFX`, `XFIR`) and version (`MV93`, etc.) are checked.

## 2. Resource Mapping
-   **Key Table**: The `KEY*` chunk is parsed first. This table maps internal Resource IDs (used by cast members) to absolute Chunk IDs in the file.
-   **Name Table**: The `Lnam` chunk is parsed to build a dictionary of strings used by scripts (variable names, handler names).

## 3. Metadata Extraction
Before processing assets, global metadata is extracted:
-   **Config (`VWCF` / `DRCF`)**: Movie stage size, frame rate, version. Saved to `movie.json`.
-   **Timeline (`VWSc`)**: Score data (frames, channels). Saved to `timeline.json`.
-   **Cast Libs (`MCsL`)**: For Movies (`main.dcr`), this table lists all external `.cct` files needed. Saved to `castlibs.json` with `preloadMode` flags.

## 4. Cast Member Discovery
The extractor makes a first pass over all `CASt` chunks:
1.  **Parse Header**: Reads member type, name, script text size, etc.
2.  **Register**: Adds the member to the internal manifest (`this.members`).
3.  **Pre-Process**: Collects Palettes (`CLUT`) immediately as they are dependencies for Bitmaps.

## 5. Content Extraction (Type-Specific)
A second pass iterates through the members and invokes sub-extractors:
-   **Bitmaps**: Finds the linked `BITD` chunk (or `DIB`/`Abmp`/`PMBA`). Decompresses image data. Applies `CLUT` (Palette) and `ALFA` (Alpha Mask). Exports `.png`.
-   **Scripts**: Finds `Lscr` or `STXT`. Extracts both compiled bytecode (`.lsc`) and decompiled source (`.ls`).
-   **Sounds**: Finds `SND ` or `medi`. Wraps data in a WAV header or dumps raw MP3 data.
-   **Text**: Decodes styled text chunks.

## 6. Output Generation
-   **Assets**: Saved to the output directory.
-   **Manifest**: A `members.json` (or merged `movie.json`) is written, listing all extracted members with metadata and checksums.
