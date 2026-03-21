# Font Extraction

This page describes the current handling of Director Font members (Type 16).

## Source Chunks

The extractor recognizes embedded font payloads from:

- `FONT`
- `VWFT`

Font members are selected with `--font`.

## Detection Strategy

Director font members often wrap another font format instead of storing a plain modern font file from byte zero.

`FontExtractor` scans the first 512 bytes for common signatures:

- `0x00010000` for TrueType
- `OTTO` for OpenType

If a known signature is found, the output is trimmed so the exported file starts at the detected font header.

## Output

Depending on what is detected, the extractor writes:

- `.ttf`
- `.otf`
- `.font` when no standard embedded font signature is found

The `.font` path is a preservation format, not a standardized interchange format.

## Current Limitations

- Director-specific font metadata is not reconstructed into a modern font editor model.
- The extractor does not rebuild Mac resource-fork font structures.
- Font naming tables are not currently surfaced into `members.json`.
