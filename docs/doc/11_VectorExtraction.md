# Shape vs. Vector Shape Extraction

Adobe Director supports two distinct types of vector-based members, which evolved at different times in the product's history. `mx-shock-ripper-js` handles them separately due to fundamental differences in their binary storage formats.

## QuickDraw Shapes (Type 8)

**Legacy "Shape"** members (Type 8) date back to the earliest versions of Director (MacroMind VideoWorks).

*   **Technology**: Based on ancient Macintosh QuickDraw specifications.
*   **Capabilities**: Limited to simple geometric primitives (Rectangle, Oval, RoundRect, Line).
*   **Storage**: Defined by a simple struct containing `rect`, `pattern`, `lineSize`, and `color` indices.
*   **Extraction**: Handled by `ShapeExtractor.js`. Converted to simple SVG standard shapes (`<rect>`, `<ellipse>`, `<line>`).
*   **CLI Flag**: `--shape`

## Vector Shapes (Type 18)

**"Vector Shape"** members (Type 18) were introduced in Director 7 to compete with Flash.

*   **Technology**: Uses a proprietary vector engine similar to a subset of Flash (SWF).
*   **Capabilities**: Full Bézier curves, complex paths, gradients, anti-aliasing, and fill styles.
*   **Storage**: Stored in a complex binary stream (often chunked as `dvect`) containing proprietary opcodes for path construction.
*   **Extraction**: Handled by `VectorShapeExtractor.js`.
    *   **Strategy**: Due to the proprietary and undocumented nature of the binary format, and the lack of a known open-source parser, these members are extracted as **Raw Binary Data** (`.bin`).
    *   **Output**: `.bin` (Raw Binary).
*   **CLI Flag**: currently covered by `--shape` rather than a separate `--vector` switch.

## Why Separate Extractors?

While `ShapeExtractor` can easily produce SVG output because it deals with simple fixed metadata, `VectorShapeExtractor` deals with a complex stream. Currently, the extractor preserves the raw payload for future analysis instead of attempting a partial or lossy SVG conversion.
