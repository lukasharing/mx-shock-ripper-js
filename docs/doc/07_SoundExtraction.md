# Sound Extraction: Formats and Headers

This document describes the process of identifying and extracting sound assets from Adobe Director `SND` chunks.

## Supported Formats

The `SoundExtractor` identifies various audio formats commonly used in Director movies:

- **MP3 / SWA**: Compressed audio files. SWA (Shockwave Audio) is essentially MP3 bitstreams with a specific Director header.
- **WAV / RIFF**: Standard Windows audio format.
- **PCM**: Raw, uncompressed audio data extracted from `SND` chunks.

## Extraction Workflow

The extraction process involves format detection and metadata reconstruction:

1. **Format Detection**:
    - **MP3 Magic**: Checks for ID3 tags or MP3 frequency sync frames (`0xFFE0`).
    - **RIFF Magic**: Identifies standard WAV containers.
2. **Header Parsing**: 
    - Analyzes `SND` records to determine sample rate, channel count, and sample size (8-bit or 16-bit).
    - Differentiates between **Standard** (8-bit mono) and **Extended** (multi-channel, high-fidelity) headers.
3. **WAV Reconstruction**:
    - If raw PCM data is found, the extractor generates a standard 44-byte RIFF/WAV header.
    - This ensure that extracted raw bytes are playable in modern media players.

## Implementation Details

- **Xmedia/SWA Handling**: Specific logic is used to skip the `medi` headers and locate the MP3 bitstream start.
- **Byte Order**: Director sound headers are typically Big-Endian, consistent with the Macintosh origins of the platform.
