# Bitmap Extraction

This document describes the current bitmap path implemented by `BitmapExtractor`.

## Supported Source Chunks

Bitmap payloads may arrive through:

- `BITD`
- `DIB`
- `Abmp`
- `PMBA`

Protected or reversed forms are normalized before bitmap extraction starts.

## Geometry Sources

The extractor does not trust a single geometry source. It builds candidate width/height sets from:

1. the member spec rectangle (`_initialRect`)
2. enriched cast metadata (`width`, `height`)

If no usable geometry can be derived, the bitmap is preserved as raw data instead of silently discarded.

## Decompression Strategy

For each candidate depth and geometry pair, the extractor tries multiple payload interpretations:

- raw
- PackBits
- zlib
- zlib followed by PackBits
- row-based PackBits variants for legacy content

Row-byte padding is tested across several alignment values until a consistent configuration is found.

## Pixel Reconstruction

Once a valid layout is identified, the extractor converts the source into RGBA output:

- indexed depths `1/2/4/8` use a resolved palette
- `16-bit` pixels are unpacked as 5-bit RGB
- `32-bit` bitmaps support chunky and planar variants
- optional `ALFA` data overrides or augments per-pixel alpha

The final image is written through `pngjs`.

## Palette Interaction

For indexed images the extractor prefers a caller-supplied palette, otherwise it asks `Palette.resolveMemberPalette()`.

If `--colored` is disabled, low-depth images intentionally fall back to grayscale rendering.

## Fallback Behavior

Bitmap extraction is designed to preserve questionable assets rather than fail closed:

- dummy/empty bitmap payloads are skipped
- payloads with data but no recoverable geometry are saved as raw `.dat`
- unmatched payloads log an error instead of emitting a misleading PNG
