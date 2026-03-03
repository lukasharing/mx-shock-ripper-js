const fs = require('fs');
const path = require('path');
const BaseExtractor = require('./BaseExtractor');

/**
 * @version 1.4.3
 * DigitalVideoExtractor.js - Strips Director wrappers from embedded video assets (.mov / .avi)
 */
class DigitalVideoExtractor extends BaseExtractor {
    async extract(data, outPath, member) {
        if (!data || data.length < 8) return null;

        try {
            // DigitalVideo (usually Type 10) may contain QuickTime ('moov', 'mdat' headers) or AVI ('RIFF' headers).
            // Sometimes it's wrapped in `vwqt` or `vwa1` Director metadata.
            let videoStart = -1;
            let extension = '.dat';

            // Scan for QuickTime 'mdat' (Movie Data) or 'moov' (Movie Box)
            for (let i = 0; i < data.length - 4; i++) {
                if (data[i] === 0x6D && data[i + 1] === 0x6F && data[i + 2] === 0x6F && data[i + 3] === 0x76) { // 'moov'
                    // The valid QuickTime structure begins 4 bytes BEFORE the header tag (the 32-bit length)
                    videoStart = Math.max(0, i - 4);
                    extension = '.mov';
                    break;
                } else if (data[i] === 0x6D && data[i + 1] === 0x64 && data[i + 2] === 0x61 && data[i + 3] === 0x74) { // 'mdat'
                    videoStart = Math.max(0, i - 4);
                    extension = '.mov';
                    break;
                } else if (data[i] === 0x52 && data[i + 1] === 0x49 && data[i + 2] === 0x46 && data[i + 3] === 0x46) { // 'RIFF' (AVI)
                    videoStart = i;
                    extension = '.avi';
                    break;
                }
            }

            if (videoStart === -1) {
                // Return untouched data if we can't identify standard headers
                return await this.saveRaw(data, outPath);
            }

            const videoData = data.slice(videoStart);
            const finalPath = outPath.replace(/\.dat$/, extension);

            await fs.promises.mkdir(path.dirname(finalPath), { recursive: true });
            await fs.promises.writeFile(finalPath, videoData);

            this.log('INFO', `Extracted Digital Video: ${path.basename(finalPath)}`);

            return { path: finalPath, format: extension.replace('.', '') };

        } catch (e) {
            this.log('ERROR', `Failed to extract DigitalVideo member ${member ? member.id : 'unknown'}: ${e.message}`);
            return null;
        }
    }

    async saveRaw(data, outPath) {
        await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
        await fs.promises.writeFile(outPath, data);
        return { path: outPath, format: 'dat' };
    }
}

module.exports = DigitalVideoExtractor;
