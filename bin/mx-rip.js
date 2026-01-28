#!/usr/bin/env node
/**
 * @version 1.2.0
 * mx-rip.js - Command-line interface for mx-shock-ripper-js
 * 
 * Provides a standardized CLI for extracting assets from .dcr, .cct, and .dir files. 
 * Supports selective extraction via flags and automatic project linkage discovery.
 */

const path = require('path');
const fs = require('fs');
const { DCRExtractor, CCTExtractor } = require('../index');

function showHelp() {
    process.stdout.write(`
mx-shock-ripper-js - Production Grade Director Asset Ripper v1.2.0

Usage:
  mx-rip <input_file> [output_dir] [options]

Options:
  --bitmap    Extract PNG images
  --script    Decompile Lingo scripts (.ls)
  --sound     Extract WAV/MP3 audio
  --palette   Extract palette JSONs
  --shape     Generate SVG for vector shapes
  --text      Extract text members
  --field     Extract field members
  --font      Extract font binary chunks
  --xtra      Extract Xtra binary blobs
  --lasm      Generate Lingo assembly files (.lasm)
  --colored   Attempt bitmap colorization (requires palette discovery)
  --force     Overwrite existing output directories
  --help      Show this help message

Example:
  mx-rip intro.dcr ./output --bitmap --script --colored
\n`);
}

async function main() {
    const args = process.argv.slice(2);
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
        showHelp();
        return;
    }

    const inputPath = path.resolve(args[0]);
    if (!fs.existsSync(inputPath)) {
        process.stderr.write(`[Error] File not found: ${inputPath}\n`);
        process.exit(1);
    }

    let outputDir = (args[1] && !args[1].startsWith('--')) ? path.resolve(args[1]) : path.join(process.cwd(), 'extraction_' + path.parse(inputPath).name);

    const flags = args.filter(a => a.startsWith('--'));
    const options = {
        bitmap: flags.includes('--bitmap'),
        script: flags.includes('--script'),
        sound: flags.includes('--sound'),
        palette: flags.includes('--palette'),
        shape: flags.includes('--shape'),
        text: flags.includes('--text'),
        field: flags.includes('--field'),
        font: flags.includes('--font'),
        xtra: flags.includes('--xtra'),
        lasm: flags.includes('--lasm'),
        colored: flags.includes('--colored')
    };

    // Default to full extraction if no specific type flags are provided
    if (!Object.values(options).some(v => v)) {
        Object.keys(options).forEach(k => options[k] = (k !== 'colored'));
    }

    if (flags.includes('--force') && fs.existsSync(outputDir)) {
        fs.rmSync(outputDir, { recursive: true, force: true });
    }

    try {
        const isDCR = inputPath.toLowerCase().endsWith('.dcr');
        const extractor = isDCR
            ? new DCRExtractor(inputPath, outputDir, options)
            : new CCTExtractor(inputPath, outputDir, options);

        process.stdout.write(`[INFO] Initializing: ${path.basename(inputPath)} -> ${outputDir}\n`);
        await extractor.extract();
        process.stdout.write(`[SUCCESS] Assets extracted successfully.\n`);
    } catch (e) {
        process.stderr.write(`[FATAL] ${e.message}\n`);
        process.exit(1);
    }
}

main();
