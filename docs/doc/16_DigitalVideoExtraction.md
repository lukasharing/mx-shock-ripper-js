# Digital Video Extraction

This page covers Digital Video members (Type 10).

## Source Chunks

Digital video members are typically identified from:

- `MooV`
- `VdM`

These members do not currently have a dedicated CLI switch such as `--video`. They are handled when the standard member-processing path discovers them.

## Wrapper Stripping

Director often wraps embedded video assets in additional member-local metadata. `DigitalVideoExtractor` does not attempt to interpret the full wrapper. Instead it scans the payload for a recognizable container start:

- `moov`
- `mdat`
- `RIFF`

If a QuickTime marker is found, extraction starts 4 bytes earlier so the exported data includes the atom length field.

## Output

Depending on the detected signature, the extractor writes:

- `.mov`
- `.avi`
- `.dat` when no standard embedded video header is found

The `.dat` case means the payload was preserved, not decoded.

## Current Limitations

- Director-side playback metadata is not reconstructed.
- The extractor does not validate the full QuickTime or AVI structure after the initial signature match.
- Container formats other than QuickTime and AVI currently fall back to raw preservation.
