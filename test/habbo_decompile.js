const fs = require('fs');
const path = require('path');
const { DCRExtractor, CCTExtractor, ProjectExtractor } = require('../index');
const cleanup = require('./cleanup_output');

const SOURCE_DIR = '/Users/lukasharing/Library/Application Support/Habbo Launcher/downloads/shockwave/262/Habbo.app/Contents/SharedSupport/prefix/drive_c/Program Files (x86)/Habbo Hotel';
const OUTPUT_ROOT = path.resolve(__dirname, 'output');
const ENTRY_FILE = 'habbo.dcr';

async function run() {
    console.log(`🚀 Starting Refined Project Extraction Test`);

    // 1. Cleanup first
    await cleanup(OUTPUT_ROOT);

    // 2. Targeted Extraction (Verification)
    const options = {
        sound: true,
        text: true,
        field: true,
        lasm: true,
        scanDirectory: true
    };

    // 2. Scan for all .cct files
    const allFiles = fs.readdirSync(SOURCE_DIR)
        .filter(f => f.endsWith('.cct') && !f.endsWith('.cct.cct')) // Exclude duplicates like "empty.cct.cct"
        .sort();

    console.log(`\n📦 Found ${allFiles.length} CCT files to extract\n`);

    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < allFiles.length; i++) {
        const file = allFiles[i];
        const entryPath = path.join(SOURCE_DIR, file);
        const outDir = path.join(OUTPUT_ROOT, path.parse(file).name);

        console.log(`\n[${i + 1}/${allFiles.length}] Extracting ${file}...`);

        try {
            const extractor = new CCTExtractor(entryPath, outDir, options);
            await extractor.extract();
            console.log(`✅ Success: ${file}`);
            successCount++;
        } catch (e) {
            console.error(`❌ Failed: ${file} - ${e.message}`);
            failCount++;
        }
    }

    console.log(`\n📊 Extraction Complete:`);
    console.log(`   ✅ Success: ${successCount}/${allFiles.length}`);
    console.log(`   ❌ Failed:  ${failCount}/${allFiles.length}`);

    console.log(`📂 Output available at: ${OUTPUT_ROOT}`);
}

run().catch(err => {
    console.error(`💥 Fatal error:`, err);
    process.exit(1);
});
