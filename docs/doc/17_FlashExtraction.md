# Flash Extraction

This page covers Flash members (Type 19).

## Source Chunks

Flash members are typically identified from `Flas` content.

There is no dedicated `--flash` CLI switch today. Flash members are handled when they are surfaced by the standard extractor pass.

## SWF Detection

`FlashExtractor` scans the member payload for a standard SWF signature:

- `FWS`
- `CWS`

When a signature is found, the extractor strips any leading Director wrapper bytes and writes the remainder as a standalone SWF.

## Output

The current output rules are:

- `.swf` when a valid SWF signature is found
- `.dat` when the payload is preserved without a recoverable SWF start

## Current Limitations

- Only `FWS` and `CWS` signatures are checked.
- The extractor does not currently inspect or rewrite SWF tag structure.
- Wrapper stripping is signature-based rather than format-aware.
