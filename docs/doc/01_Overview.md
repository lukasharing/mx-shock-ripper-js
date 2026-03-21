# Extractor Architecture Overview

`mx-shock-ripper-js` is built as a layered extractor rather than a single monolithic parser. The current pipeline is centered on `DirectorExtractor`, with thin wrappers for project-wide (`DCRExtractor`) and standalone cast (`CCTExtractor`) entry points.

## Entry Points

### `mx-rip`

The CLI front-end routes `.dcr` files through `DCRExtractor` and standalone `.cct` / `.cst` files through `CCTExtractor`.

### `DCRExtractor`

Used for movie projects. It builds a `ProjectExtractor` context first, resolves linked casts from `MCsL`, and then runs one `DirectorExtractor` per discovered segment. Shared palette context is propagated across those runs.

### `CCTExtractor`

Used for standalone cast libraries. It delegates straight to `DirectorExtractor`.

## Core Components

### `DirectorFile`

Low-level RIFX/XFIR parser. It:

- validates the file header and version
- parses `mmap` / `imap`
- expands Afterburned `FGDC` content
- exposes normalized chunk tags, including protected / reversed FourCC variants
- serves inline ILS-resident chunk data to the extractor and worker pool

### `MetadataManager`

Builds movie-wide lookup tables and metadata:

- `KEY*` logical resource map
- `Lnam` name tables
- `Lctx` script-to-bytecode mapping
- `DRCF` / `VWCF` movie config
- `MCsL` external cast linkage

### `CastManager`

Owns member discovery and enrichment. It aggregates member IDs, assigns initial types from authoritative content chunks, and folds `CASt` metadata into `CastMember` instances.

### `MemberProcessor`

Handles pre-worker member preparation, especially palette discovery and member-local metadata needed before parallel extraction starts.

### Worker Pool

The main extraction pass runs in worker threads. Each worker gets:

- a shared file descriptor
- normalized chunk metadata
- the resolved key table and script mappings
- optional inline ILS data for Afterburned files

Workers perform the heavy per-member extraction and return output metadata back to `DirectorExtractor`.

## Specialized Extractors

- `BitmapExtractor`: bitmap decompression, palette application, alpha composition, PNG output
- `LingoDecompiler`: Lingo bytecode to AST/source translation
- `SoundExtractor`: WAV/MP3/IMA4 handling
- `TextExtractor`: RTF or raw-text output
- `PaletteExtractor`: JASC-PAL output
- `ShapeExtractor`: QuickDraw shape to SVG
- `VectorShapeExtractor`: raw binary preservation for Type 18 members
- `FontExtractor`: binary font export with TTF/OTF detection
- `MovieExtractor`: FilmLoop score/timeline JSON export
- `DigitalVideoExtractor`: wrapper stripping for embedded `.mov` / `.avi` payloads
- `FlashExtractor`: SWF signature scanning and wrapper stripping
- `XtraExtractor`: embedded plugin preservation with light file-type detection
- `GenericExtractor`: `.bin` preservation for unsupported or unknown payloads

## Data Flow

1. Input file is parsed by `DirectorFile`.
2. Metadata tables are read and normalized.
3. Cast members are discovered and enriched.
4. Palette dependencies are loaded before bitmap extraction.
5. Selected members are processed in worker threads.
6. Outputs are written to disk and summarized in `members.json`, `movie.json`, `timeline.json`, and `castlibs.json` when available.
