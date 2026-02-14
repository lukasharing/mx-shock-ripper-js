const fs = require('fs');
const path = require('path');

const OUTPUT_ROOT = path.resolve(__dirname, 'output');

function cleanup() {
    console.log(`🧹 Cleaning output directory: ${OUTPUT_ROOT}`);
    if (fs.existsSync(OUTPUT_ROOT)) {
        fs.rmSync(OUTPUT_ROOT, { recursive: true, force: true });
    }
    fs.mkdirSync(OUTPUT_ROOT, { recursive: true });
    console.log(`✅ Output directory is ready and empty.\n`);
}

if (require.main === module) {
    cleanup();
}

module.exports = cleanup;
