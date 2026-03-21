# Director File Formats and Internals

This project works against Director RIFX containers used by `.dcr`, `.cct`, and `.cst` files.

## RIFX Container Basics

- `RIFX`: big-endian Director container
- `XFIR`: little-endian Director container
- `mmap` / `imap`: chunk map used to locate sections
- `FGDC`: Afterburner-compressed payload wrapper
- `ILS `: Initial Load Segment body used by some Afterburned files for inline resident chunks

The extractor normalizes chunk tags before higher-level processing. That includes both known Afterburner aliases and reversed/protected FourCC forms such as `DTIB -> BITD`, `AFLA -> ALFA`, `TULC -> CLUT`, and `FCRD -> DRCF`.

## Important Chunk Types

| Tag | Meaning | Notes |
| :--- | :--- | :--- |
| `KEY*` | Resource key table | Maps logical member/resource IDs to chunk IDs |
| `CASt` | Cast member metadata | Member header, name, flags, geometry, spec tables |
| `BITD` / `DIB` / `Abmp` / `PMBA` | Bitmap payload | Image data, sometimes protected or compressed |
| `ALFA` | Alpha plane | Optional bitmap alpha mask |
| `CLUT` | Palette payload | Palette member body |
| `Lscr` | Compiled Lingo bytecode | Decompiled by `LingoDecompiler` |
| `Lctx` | Script context map | Resolves script IDs to `Lscr` chunks |
| `Lnam` | Name table | Symbol table used during decompilation |
| `DRCF` / `VWCF` | Movie config | Stage info, default palette, member ranges |
| `VWSc` | Score/timeline | Frame/channel data |
| `MCsL` | Movie cast list | Linked external casts for `.dcr` projects |

## Afterburner Notes

Afterburned files can differ from standard RIFX files in two ways that matter to the extractor:

1. Chunk tags may be protected or reversed.
2. Actual chunk data may live inside the decompressed ILS body rather than at the physical file offset listed in the outer map.

`DirectorFile` handles both cases so downstream systems can work against normalized chunk metadata.
For content lookup, the extractor now treats the direct resource ids exposed by `ABMP` as canonical. `fmap` is retained only as an explicit alias map for special cases and should not be used as a generic payload resolver.

## `MCsL` Preload Modes

The `MCsL` table exposes how linked casts should be loaded by Director:

- `0`: load when needed
- `1`: load after frame 1
- `2`: load before frame 1

These values are preserved in `castlibs.json`.

## Common Member Types

Refer to `src/constants/MemberType.js` for the full enum. Frequently encountered values:

- `1`: Bitmap
- `2`: FilmLoop
- `3`: Text
- `4`: Palette
- `6`: Sound
- `8`: Shape
- `11`: Script
- `13`: Field
- `16`: Font
- `18`: VectorShape
- `19`: Flash
