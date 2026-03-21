# Cast Member Formats

This page summarizes how the extractor currently treats the main Director member types.

## Bitmap (Type 1)

- Typical chunks: `CASt` + `BITD` / `DIB` / `Abmp` / `PMBA`
- Optional companions: `ALFA`, `CLUT`
- Output: `.png`
- Fallback: raw `.dat` when pixel data exists but usable dimensions cannot be derived
- Dedicated page: [06_BitmapExtraction.md](06_BitmapExtraction.md)

Palette resolution for indexed bitmaps is layered:

1. explicit member palette or system palette reference
2. borrowed palette chain from another member
3. cross-cast palette resolution through project context
4. movie default palette ID
5. nearest preceding internal palette heuristic
6. extractor/project default palette fallback
7. platform system fallback

## Script (Type 11)

- Typical chunks: `CASt`, `Lscr`, `Lctx`, `Lnam`
- Output: `.ls`
- Optional output: `.lasm` when `--lasm` is enabled
- Dedicated pages: [05_LingoDecompiler.md](05_LingoDecompiler.md), [08_LingoAST.md](08_LingoAST.md)

The active code path is centered on source decompilation. Raw `.lsc` preservation exists in code, but it is not exposed as a standard CLI output.

## Sound (Type 6)

- Typical chunks: `SND `, `snd `, `medi`
- Output: `.wav`, `.mp3`, or codec-specific raw payloads such as `.ima4`
- Dedicated page: [07_SoundExtraction.md](07_SoundExtraction.md)

## Text (Type 3) and Field (Type 13)

- Typical chunks: `STXT`, `TEXT`, `TXTS`
- Default output: `.rtf`
- Raw-text passthrough: if the member name already ends with a text-like extension such as `.txt`, `.json`, `.xml`, `.html`, `.css`, `.js`, `.ls`, or `.lsc`
- Dedicated page: [13_TextAndFieldExtraction.md](13_TextAndFieldExtraction.md)

## Palette (Type 4)

- Typical chunks: `CLUT`, `Palt`
- Output: `.pal` in JASC-PAL format
- Note: palette members may be parsed even when `--palette` is off, because bitmap colorization depends on them
- Dedicated page: [09_PaletteExtraction.md](09_PaletteExtraction.md)

## FilmLoop (Type 2) and Movie (Type 9)

- Typical payload: filmloop/movie score data
- FilmLoop output: `.filmloop.json`
- Movie output: currently metadata-only or generic binary preservation
- Dedicated page: [14_FilmLoopAndMovieMembers.md](14_FilmLoopAndMovieMembers.md)

## Shape (Type 8)

- Typical chunks: `CASt` with QuickDraw-style shape metadata
- Output: `.svg`
- Dedicated page: [10_ShapeExtraction.md](10_ShapeExtraction.md)

## VectorShape (Type 18)

- Extraction flag: currently covered by `--shape`
- Output: raw binary `.bin`

The extractor preserves the payload for future analysis rather than attempting a partial SVG conversion.

- Dedicated page: [11_VectorExtraction.md](11_VectorExtraction.md)

## Font (Type 16)

- Typical chunks: `FONT`, `VWFT`
- Output: `.ttf` or `.otf` when a standard font signature is found, otherwise `.font`
- Dedicated page: [15_FontExtraction.md](15_FontExtraction.md)

## DigitalVideo (Type 10)

- Typical chunks: `MooV`, `VdM`
- Output: `.mov`, `.avi`, or raw `.dat`
- Dedicated page: [16_DigitalVideoExtraction.md](16_DigitalVideoExtraction.md)

## Flash (Type 19)

- Typical chunk: `Flas`
- Output: `.swf` or raw `.dat`
- Dedicated page: [17_FlashExtraction.md](17_FlashExtraction.md)

## Xtra (Type 15)

- Typical chunks: `XTRA`, `XTCL`
- Output: `.x32`, `.bundle`, or raw `.dat`
- Dedicated page: [18_XtraExtraction.md](18_XtraExtraction.md)

## Other Member Types

- Picture, Button, RTE, Transition, Mesh, and custom/unknown types currently use metadata-only handling or generic `.bin` preservation
- Dedicated page: [19_GenericAndMetadataOnlyMembers.md](19_GenericAndMetadataOnlyMembers.md)
