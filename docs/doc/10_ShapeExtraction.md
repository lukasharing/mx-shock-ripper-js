# Shape Extraction: SVG Generation

This document describes how `mx-shock-ripper-js` converts Adobe Director shape members into modern SVG (Scalable Vector Graphics) files.

## Shape Types

The `ShapeExtractor` identifies and processes the following geometric primitives:

1. **Rectangle**: Standard solid or outlined boxes.
2. **Round Rect**: Rectangles with predefined corner rounding (radius: 5px).
3. **Oval**: Geometric ellipses.
4. **Line**: Linear segments between coordinates.

## Color and Pattern Resolution

- **Foreground Color**: Used for strokes and solid fills.
- **Background Color**: Typically used for pattern backgrounds (currently treated as 'none' if patterns are disabled).
- **Pattern Matching**: If a shape has a pattern enabled (non-zero), the foreground color is used as the fill. Otherwise, the shape is rendered as a stroke-only outline.

## SVG Output

Shapes are exported as standards-compliant XML/SVG documents.
- **Viewport**: Automatically calculated based on the member's bounding rectangle.
- **Stroke Width**: Maps directly to Director's `lineSize` property.
- **Coordinates**: Offset by half the stroke width to ensure strokes are not clipped by the SVG viewport boundaries.
