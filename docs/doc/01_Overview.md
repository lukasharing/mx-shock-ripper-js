# Extractor Architecture Overview

The Shockwave extraction toolchain is designed as a modular pipeline to process Shockwave Director files (`.dcr`, `.cct`) and extract assets into modern, usable formats (PNG, MP3, LS, JSON).

## System Components

### 1. Orchestrator (`client-rip.js`)
The entry point for batch processing.
-   **Discovery**: Locates the Shockwave installation.
-   **Concurrency**: Manages parallel extraction of multiple files.
-   **Routing**: Identifies "Movie" files (e.g., `main.dcr`) vs. "Cast" files (`.cct`) and routes artifacts accordingly.

### 2. DirectorExtractor 
The core controller class (`DirectorExtractor` in `DirectorExtractor.js`).
-   **Parsing**: Uses `DirectorFile` to parse the RIFX binary structure.
-   **Mapping**: Resolves resource IDs using `KEY*` and `Lnam` tables.
-   **Dispatch**: Iterates through valid `CASt` members and delegates to specific sub-extractors based on member type.

### 3. Sub-Extractors
Specialized classes for handling specific data formats:
-   **BitmapExtractor**: Decodes 1/2/4/8/16/32-bit images, handles palettes (`CLUT`), and applies alpha masks (`ALFA`).
-   **SoundExtractor**: Extracts raw audio samples (`SND `, `medi`) and wraps them in WAV headers or exports MP3s.
-   **ScriptExtractor / LingoDecompiler**: Decompiles Lingo bytecode (`Lscr`) into readable source code (`.ls`), reconstructing control flow and syntax.
-   **TextExtractor / FieldExtractor**: Decodes styled text content.
-   **ShapeExtractor / VectorShapeExtractor**: Converts QuickDraw shapes to SVG and dumps complex Vector Shapes as raw data.

## Data Flow

1.  **Input**: Binary `.dcr` / `.cct` file.
2.  **Parse**: `DirectorFile` reads chunks into memory.
3.  **Map**: `KeyTable` constructs the ID -> Chunk map.
4.  **Meta**: `Config`, `Score` (`timeline.json`), and `MCsL` (`castlibs.json`) are extracted if present.
5.  **Extract**: Members are processed type-by-type.
6.  **Output**: Assets saved to disk; Metadata aggregated into `.json`.
