# Xtra Extraction

This page covers Xtra members (Type 15).

## Source Chunks

Embedded Xtras are usually discovered from:

- `XTRA`
- `XTCL`

Xtra members are selected with `--xtra`.

## Detection Strategy

Many Xtras are external plugins rather than fully embedded resources. When an Xtra payload is present in the container, `XtraExtractor` uses simple binary signatures to choose a useful file extension:

- `MZ` -> `.x32`
- Mach-O 32-bit signatures -> `.bundle`
- anything else -> `.dat`

The goal is preservation and quick identification, not plugin reverse engineering.

## Output

The extractor writes one of:

- `.x32`
- `.bundle`
- `.dat`

## Current Limitations

- Embedded Xtra metadata is not decoded beyond basic type detection.
- External Xtras referenced by the movie are not reconstructed automatically.
- Mac Xtra formats other than the simple Mach-O signatures currently fall back to `.dat`.
