# Lingo Decompiler: Name Table Calibration & Context Steering

Shockwave Project uses a sophisticated obfuscation technique involving scrambled `Lnam` (Name Table) chunks. This document details the technical breakthroughs required to achieve high-fidelity decompilation.

## The Scrambling Challenge

In standard Director files, symbols in bytecode (`pushvarref`, `getprop`, etc.) map directly to indices in the `Lnam` chunk. However, Shockwave's `fuse_client` employs:
1.  **Multiple Name Tables**: 88+ `Lnam` chunks distributed throughout the file.
2.  **Categorical Shifts**: Handlers, Global Properties, and Movie Properties often have independent relative offsets.
3.  **Context Misalignment**: Scripts are not always stored linearly next to their relevant `Lnam`.

## Technical Breakthroughs

### 1. Context Steering (Nearest Preceding Lnam)
The `DirectorExtractor` implements a "Nearest Preceding" logic. Since `mmap` chunks aren't always sequential, the extractor identifies the physical index of a script's `Lscr` chunk and searches backwards for the closest `Lnam`. This ensures the script is decompiled against the environment it was compiled in.

### 2. Categorical Shift Calibration (The Probe Technique)
We use a multi-stage heuristic to detect the scrambling "Shift" for three distinct categories:

#### Handler Alignment
We look for the common `new` (or `construct`) symbol in the Name Table. By comparing its index to the `nameId` of the first handler in the `HAND` chunk, we calculate:
`Shift = (BytecodeID - NameTableIndex + NameTableLength) % NameTableLength`

#### Global/Movie Property Alignment
We scan the bytecode of the first handler for the `traceScript` property access pattern (`the traceScript` or `_movie.traceScript`). 
-   `0x1C` (GETTOPLEVELPROP) -> Calibrates **Global Shift**
-   `0x5C` (GETMOVIEPROP) -> Calibrates **Movie Shift**

### 3. Internal Handler Resolution (Index-Based)
Crucially, internal calls (`localcall`) in modern Lingo files do **not** use name IDs. Instead, they refer to the handler's index within the `HAND` table of the current `Lscr` chunk. Our decompiler correctly maps these indices back to the calibrated handler names.

### 4. 0-Based Baseline
While some tools assume 1-based indexing for Lingo, our analysis confirmed that for Director 4-8.5 (V4-V93), a **0-based** baseline combined with the categorical shift is the most stable model for Shockwave.

## Opcode Specifics

### V4 (Director 4.0) Differences
Older scripts (like `Event Agent Class`) use a fixed 46-byte entry size in the `HAND` segment and specialized `GET`/`SET` opcodes (`0x1C`/`0x1D`) that map to a hardcoded property table (e.g., `iv 21` -> `the rect`). Our decompiler includes a manual mapping for these legacy properties.

### Complex Loops
Decompiling `repeat with ... down to` requires monitoring the stack for `peek` opcodes and reconstructing the `(start, end, variable)` triplet.
