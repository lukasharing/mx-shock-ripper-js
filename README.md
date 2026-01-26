# mx-shock-ripper-js

A high-performance library and CLI toolset for the extraction, analysis, and reconstruction of legacy Adobe Director MX 2004 assets. This project provides a robust framework for converting packed binary archives (.dcr, .cct, .cast) into standard modern formats.

![Internal Architecture](./docs/assets/internal_structure.png)
*Figure 1: Internal technical architecture of the mx-shock-ripper-js library, illustrating the hierarchical component structure and data flow.*

## Key Features

- **Multi-Phase Decompilation**: Recovers Lingo source code from obfuscated bytecode using advanced control flow analysis.
- **Universal Asset Extraction**: Supports Bitmaps (PNG), Sounds (WAV/MP3), Palettes (PAL/JSON), Text (UTF-8), and Shapes.
- **Complex Project Mapping**: Automatically resolves external cast library linkages and reconstructs the extraction hierarchy.
- **Academic Precision**: Implements a stack-based AST generator to ensure high-fidelity source recovery.
- **Modern Pipeline**: Built on Node.js with efficient memory handling for large project files.

## Technical Foundation

The library is designed around a decoupled architecture that separates low-level binary parsing from high-level asset extraction logic.

### Decompilation Workflow

The reconstruction of Lingo source code follows a rigorous four-phase process to ensure accuracy even in the presence of scrambled symbols or non-standard bytecode patterns.

![Decompilation Workflow](./docs/assets/decompilation_workflow.png)
*Figure 2: Schematic representation of the multi-phase Lingo decompilation process.*

1. **Schema Mapping**: Identifies the internal Director version (V4 through V93) and maps internal segments.
2. **Bytecode Decoding**: Translates variable-length numeric opcodes into mnemonics.
3. **AST Construction**: Uses a stack machine model to build an Abstract Syntax Tree, reconstructing control flows (if/else, loops, cases).
4. **Source Generation**: Emits formatted Lingo code based on the AST structure.

## Project Status

### Accomplished Tasks
- Multi-threaded (recursive) project extraction for .dcr and .cct.
- Robust Bitmap extraction with palette resolution and alpha reconstruction.
- Advanced Lingo decompilation foundation with AST support.
- Standardized CLI output and logging (Production 1.0 grade).
- Comprehensive technical documentation and architecture diagrams.

### Pending / Known Issues
- Palette-Member Association: Some complex projects may require manual palette linkage correction in metadata.
- Lingo Edge Cases: Certain obfuscation patterns might result in minor syntax inaccuracies.
- Shape Reconstruction: Vector shape data parsing is currently experimental.

## Installation

```bash
npm install mx-shock-ripper-js
```

## Usage

### CLI Tool
The library includes a universal CLI for rapid extraction:

```bash
# Extract all assets from a file
mx-rip path/to/file.dcr --output ./extraction

# Extract only scripts with assembly view
mx-rip file.cct --script --lasm
```

### Library Usage
Integrate the extraction logic directly into your Node.js application:

```javascript
const { DCRExtractor } = require('mx-shock-ripper-js');

async function rip() {
    const extractor = new DCRExtractor('project.dcr', './output', {
        bitmap: true,
        script: true,
        colored: true
    });
    await extractor.extract();
}
```

## API Reference

### `DirectorFile`
The core parser. Reads the chunked binary structure and resolves the `KEY` table.

### `DCRExtractor` / `CCTExtractor`
Orchestrators that handle the recursive extraction of movies and cast libraries.

### `LingoDecompiler`
The decompiler module. Can be used standalone to convert `Lscr` chunks into source code.

## Donation

If you find this project useful, consider supporting its development.
**PayPal**: [@lukasharinggarcia](https://www.paypal.me/lukasharinggarcia)

## Acknowledgments

This project uses [ProjectorRays](https://github.com/ProjectorRays/ProjectorRays) as a primary technical reference for Director binary specifications and Lingo bytecode mapping.

## License

This project is licensed under the MIT License.
