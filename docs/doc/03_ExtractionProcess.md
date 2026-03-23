# Extraction Process

This document describes the current `DirectorExtractor` pipeline.

## 1. Parse and Normalize the Container

- Open the input file with a shared file descriptor.
- Parse the RIFX/XFIR header and chunk map through `DirectorFile`.
- If the file is Afterburned, decompress the `FGDC` payload and cache the ILS body for inline resident chunks.
- Normalize protected and reversed chunk tags before they reach metadata or extraction code.

## 2. Build Metadata Tables

`MetadataManager` performs the first metadata pass:

- parse `KEY*` into a logical resource map
- parse `MCsL` and build cast ordering / external cast linkage
- parse every available `Lnam` table
- parse `DRCF` / `VWCF` movie configuration, including palette defaults when present
- load optional `shared_palettes.json` from the input directory

## 3. Discover and Enrich Cast Members

`CastManager` then walks the file and builds `CastMember` objects:

1. Seed members from authoritative chunk references.
2. Fold in `CASt` metadata and type-specific specs.
3. Reassign member types from content chunks when the original member header is weak or protected.
4. Drop obvious empty/null placeholders from the final manifest stage.

## 4. Load Palette Dependencies

Before the worker pool starts, palette members are parsed so bitmap and shape extraction can resolve color information. This step runs when any of these are enabled:

- `--palette`
- `--bitmap`
- `--shape`
- `--colored`

Palette output files are only written when `--palette` is explicitly enabled.

## 5. Queue Selectable Member Work

The main processing queue is filtered by the requested extraction flags. Only selected member types are sent to workers.

Each task includes:

- normalized chunk metadata
- key table mappings
- script context/name-table info
- resolved palette data for bitmap/shape members
- the previous checksum from `members.json`, when available

## 6. Worker Extraction

Workers read chunk data directly from the shared descriptor or from cached ILS data for inline chunks.

Per-member behavior includes:

- bitmaps: decode payload, resolve palette, apply alpha, write `.png` or fall back to raw data
- scripts: resolve `Lscr`, select the best name table, decompile to `.ls`, optionally emit `.lasm`
- text/fields: write `.rtf` unless the name already implies a raw text-like extension
- palettes: format as JASC-PAL `.pal`
- sounds: write `.wav`, `.mp3`, or codec-specific binary output depending on the source
- filmloops: emit heuristic timeline JSON ending in `.filmloop.json`
- digital video: strip Director wrapper bytes and preserve `.mov`, `.avi`, or raw `.dat`
- flash: strip wrapper bytes and preserve `.swf` or raw `.dat`
- xtras: preserve embedded plugin payloads as `.x32`, `.bundle`, or `.dat`
- unknown/generic payloads: persist `.bin` output and count that as a successful extraction

If a member checksum matches the previous manifest and `--force` is not set, the worker reports `SKIP` and the old artifact metadata is restored.

Worker outcomes are now classified more explicitly than the old generic `no_output` bucket. The manifest distinguishes unresolved references, placeholder-only sources, empty assets, and unsupported content so extraction misses are easier to interpret.

Normal logging is intentionally summarized:

- per-member placeholder/external skip spam is collapsed into end-of-run summaries
- progress is logged at coarse milestones instead of once per member
- worker `DEBUG` chatter is suppressed unless `--verbose` is enabled

Real worker errors, unsupported-content warnings, and geometry recovery messages still remain visible.

## 7. Finalization

After worker completion, `DirectorExtractor`:

- runs dangling-script matching when script extraction is enabled
- finalizes cast-lib metadata
- normalizes manifest output fields
- writes `members.json`
- writes `movie.json`, `timeline.json`, and `castlibs.json` when available
- writes `<input>_extraction.log`

The `members.json` file stores per-member artifact references under type-appropriate fields such as `image`, `scriptFile`, `paletteFile`, `textFile`, `soundFile`, and `dataFile`.
