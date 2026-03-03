const fs = require('fs');
const path = require('path');
const BaseExtractor = require('./BaseExtractor');

/**
 * @version 1.4.3
 * FlashExtractor.js - Strips Macromedia Director wrapping from embedded SWF chunks
 */
class FlashExtractor extends BaseExtractor {
    async extract(data, outPath, member) {
        if (!data || data.length < 8) return null;

        try {
            // Flash SWF signatures are 'FWS' (uncompressed, SWF 1-5+) or 'CWS' (zlib compressed, SWF 6+)
            // followed by a 1-byte version number and a 4-byte little-endian file size.
            // Director typically wraps these in 'FLSW' or 'fcs ' headers. We can scan for the FWS/CWS signature.
            let swfStart = -1;

            for (let i = 0; i < data.length - 3; i++) {
                if ((data[i] === 0x46 || data[i] === 0x43) && data[i + 1] === 0x57 && data[i + 2] === 0x53) {
                    swfStart = i;
                    break;
                }
            }

            if (swfStart === -1) {
                // No SWF magic found, fallback to saving raw chunk
                return await this.saveRaw(data, outPath.replace('.swf', '.dat'));
            }

            const swfData = data.slice(swfStart);

            // Add `.swf` extension explicitly
            const finalPath = outPath.endsWith('.swf') ? outPath : outPath + '.swf';
            await fs.promises.mkdir(path.dirname(finalPath), { recursive: true });
            await fs.promises.writeFile(finalPath, swfData);

            this.log('INFO', `Extracted Flash SWF: ${path.basename(finalPath)}`);

            return { path: finalPath, format: 'swf' };
        } catch (e) {
            this.log('ERROR', `Failed to extract Flash member ${member ? member.id : 'unknown'}: ${e.message}`);
            return null;
        }
    }

    async saveRaw(data, outPath) {
        await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
        await fs.promises.writeFile(outPath, data);
        return { path: outPath, format: 'dat' };
    }
}

module.exports = FlashExtractor;
