# Director File Formats & Internals

Background information on the binary structure of Director files processed by this tool.

## RIFX Container

Director files use the **RIFX** (Resource Interchange File Format - Extended) structure, detailed as follows:

-   **Header**: `RIFX` (Big Endian) or `XFIR` (Little Endian).
-   **Map**: Usually `mmap` or `IMAP`. Contains pointers to all other chunks in the file.
-   **Afterburner**: Compresssed files (`FGDC`) are "Afterburned" (Zlib compressed). The extractor handles decompression transparently via `DirectorFile`.

### Key Chunks

| Magic Tag | Name | Description |
| :--- | :--- | :--- |
| `KEY*` | Key Table | Maps logical Resource IDs (CastMember IDs) to Chunk IDs (Indices in the file). |
| `Lnam` | Name Table | Stores variable and handler names for Lingo scripts. |
| `CASt` | Cast Member | Contains metadata (type, name, size, rectangle) for a single member. |
| `Lscr` | Script | Compiled Lingo bytecode. |
| `Lctx` | Lingo Context | Maps Script IDs to `Lscr` chunks (essential for generic script extraction). |
| `MCsL` | Movie Cast List | (Movie only) List of external cast libraries (.cct) linked to the movie. |
| `VWSc` | Score | (Movie only) Timeline data (frames, channels, sprite placement). |

## Preload Modes (MCsL)

The `MCsL` chunk defines external casts and their load behavior:

-   **Mode 0**: Load When Needed.
-   **Mode 1**: Load After Frame 1.
-   **Mode 2**: Load Before Frame 1.

These flags are extracted into `castlibs.json`.

## Member Type IDs

Refer to `Constants.js` for the full Enum `MemberType`. Common IDs:

-   `1`: Bitmap
-   `4`: Palette
-   `6`: Sound
-   `11`: Script
-   `18`: Vector Shape
