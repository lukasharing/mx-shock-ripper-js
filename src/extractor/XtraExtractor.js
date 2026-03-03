const fs = require('fs');
const path = require('path');
const BaseExtractor = require('./BaseExtractor');

/**
 * @version 1.4.3
 * XtraExtractor.js - Dumps embedded Xtra plugins (.x32 / OSX binaries) 
 */
class XtraExtractor extends BaseExtractor {
    async extract(data, outPath, member) {
        if (!data || data.length < 8) return null;

        try {
            // Xtras (Type 15) are often external files but sometimes bundled in the DCR.
            // When bundled, they are mostly just standard PE executable (.x32 on Windows) or Mac Resource Forks. 
            // We do a heuristic scan to assign an extension, mostly for identification purposes.
            let extension = '.dat';

            // Check PE signature 'MZ' for Windows Xtras
            if (data[0] === 0x4D && data[1] === 0x5A) {
                extension = '.x32'; // Standard Windows Director plugin extension (technically a DLL)
            } else if (data[0] === 0xFE && data[1] === 0xED && data[2] === 0xFA && data[3] === 0xCE) {
                // Mach-O (32-bit Mac)
                extension = '.bundle';
            } else if (data[0] === 0xCE && data[1] === 0xFA && data[2] === 0xED && data[3] === 0xFE) {
                // Mach-O (32-bit Mac reversed)
                extension = '.bundle';
            }

            const finalPath = outPath.replace(/\.dat$/, extension);

            await fs.promises.mkdir(path.dirname(finalPath), { recursive: true });
            await fs.promises.writeFile(finalPath, data);

            this.log('INFO', `Extracted Xtra Plugin: ${path.basename(finalPath)}`);

            return { path: finalPath, format: extension.replace('.', '') };

        } catch (e) {
            this.log('ERROR', `Failed to extract Xtra member ${member ? member.id : 'unknown'}: ${e.message}`);
            return null;
        }
    }
}

module.exports = XtraExtractor;
