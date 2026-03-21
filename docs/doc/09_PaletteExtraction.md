# Palette Extraction

This document covers both palette parsing and palette resolution.

## Palette Payload Formats

Director `CLUT` data appears in several layouts. The project supports:

### 16-bit channel format

- `6` bytes per color
- typically older / Mac-oriented assets
- each channel is read as a big-endian 16-bit value and reduced to 8-bit RGB

### 8-bit RGB format

- `3` bytes per color
- the common case for standard 256-color palettes

### 4-byte extended format

- `4` bytes per color
- treated as RGB plus padding/alpha

The runtime palette path uses `Palette.parseDirector()`. The dedicated `PaletteExtractor` also contains a multi-strategy parser for exporting standalone palette members.

## Palette ID Normalization

Director uses negative and zero-adjacent palette IDs to represent built-in system palettes. The code normalizes raw IDs so system references have stable meanings before resolution.

Examples:

- `0` in raw member metadata normalizes to the explicit Mac system palette
- positive IDs remain cast/member references

Movie-default inheritance is handled separately from explicit negative system-palette IDs.

## Resolution Order

When a bitmap or shape needs a palette, the resolver walks several sources in order:

1. explicit system palette IDs
2. direct palette-member references
3. borrowed palette chains from other members
4. cross-cast/project palette lookups
5. movie default palette ID
6. nearest preceding internal palette heuristic
7. extractor/project default palette fallback
8. platform system fallback

This is why palette members may be parsed even when `--palette` is not enabled.

## Export Format

Standalone palette exports use JASC-PAL:

1. `JASC-PAL`
2. `0100`
3. `256`
4. `256` lines of `R G B`

The emitted file extension is `.pal`.
