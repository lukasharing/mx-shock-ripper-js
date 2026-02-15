# Debug & Diagnostic Scripts

This directory contains specialized scripts used during the development and debugging of the decompiler. These are intended for technical deep-dives and verification, not for production extraction flows.

## Core Diagnostics
- **`debug_minmember_extractor.js`**: Analyzes movie metadata to determine the `minMember` offset (critical for palette resolution).
- **`debug_pal_verify.js`**: Targeted verification of palette-to-slot mapping for specific assets.
- **`debug_chunk_audit.js`**: Lists all chunks and their properties for a given file.

## Usage
Run any script using Node.js:
```bash
node scripts/debug/debug_minmember_extractor.js
```
