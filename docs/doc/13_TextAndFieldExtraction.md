# Text and Field Extraction

This page covers Director Text members (Type 3) and Field members (Type 13).

## Source Chunks

The current text path accepts these chunk families:

- `STXT`
- `TEXT`
- `TXTS`

Both Text and Field members are routed through `TextExtractor`.

## Selection

- Text members are selected with `--text`
- Field members are selected with `--field`

If no extraction-type flags are supplied, both types are included in the default extractor set.

## Decoding Strategy

`TextExtractor` uses a conservative decode path:

1. If the payload looks like an `STXT` record, read the 12-byte header.
2. Use the declared text length to slice the text payload.
3. Otherwise decode the entire buffer as plain text.
4. Strip NUL bytes and trim the final string.

The parser does not currently rebuild Director style runs in a structured way.

## Output Modes

The default output is `.rtf`.

Raw text passthrough is enabled when the member name already implies a text-like asset extension:

- `.props`
- `.txt`
- `.json`
- `.xml`
- `.html`
- `.css`
- `.js`
- `.ls`
- `.lsc`

In raw mode the existing extension is preserved and the extractor does not wrap the content in RTF.

## Metadata

`MemberSpec.TextSpec` currently parses the member rectangle, so `members.json` may include `rect` for Text and Field members when that metadata is present.

## Current Limitations

- `RTE` (Type 12) is a separate member type and is not handled by this extractor.
- Styled `STXT` content is flattened to plain text before optional RTF wrapping.
- Encoding detection is minimal and assumes the payload is already usable as text.
