/**
 * @version 1.3.5
 * ShapeExtractor.js - Processing and SVG generation for Director Shape members.
 * 
 * See docs/doc/10_ShapeExtraction.md for technical details.
 */

const GenericExtractor = require('./GenericExtractor');
const { Color } = require('../utils/Color');

class ShapeExtractor extends GenericExtractor {
    constructor(log) {
        super(log);
    }

    /**
     * Resolves shape metadata into a standardized SVG string.
     */
    extract(member, palette) {
        const fore = Color.resolve(member.foreColor, palette);
        const back = Color.resolve(member.backColor, palette);
        const width = Math.abs(member.rect.right - member.rect.left) || member.lineSize || 1;
        const height = Math.abs(member.rect.bottom - member.rect.top) || member.lineSize || 1;

        let svgContent = "";
        const sw = member.lineSize || 0;
        const fill = (member.pattern !== 0) ? fore : 'none';

        switch (member.shapeType) {
            case 1: // Rectangle
            case 2: // Round Rect
                const rx = (member.shapeType === 2) ? 5 : 0;
                svgContent = `<rect x="${sw / 2}" y="${sw / 2}" width="${width - sw}" height="${height - sw}" rx="${rx}" fill="${fill}" stroke="${fore}" stroke-width="${sw}" />`;
                break;
            case 3: // Oval
                svgContent = `<ellipse cx="${width / 2}" cy="${height / 2}" rx="${(width - sw) / 2}" ry="${(height - sw) / 2}" fill="${fill}" stroke="${fore}" stroke-width="${sw}" />`;
                break;
            case 4: // Line
                svgContent = `<line x1="0" y1="0" x2="${width}" y2="${height}" stroke="${fore}" stroke-width="${sw}" />`;
                break;
        }

        return `<?xml version="1.0" encoding="UTF-8"?>\n<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">\n  ${svgContent}\n</svg>`;
    }

    /**
     * Saves the generated SVG to the filesystem.
     */
    save(outputPath, member, palette) {
        const svg = this.extract(member, palette);
        const finalPath = outputPath.endsWith('.svg') ? outputPath : outputPath + '.svg';
        const result = this.saveFile(Buffer.from(svg, 'utf8'), finalPath, "Shape (SVG)");
        if (result) {
            return {
                file: result.file,
                size: result.size,
                format: 'svg'
            };
        }
        return false;
    }
}

module.exports = ShapeExtractor;
