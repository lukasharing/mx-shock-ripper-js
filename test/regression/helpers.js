const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const cliPath = path.join(repoRoot, 'bin', 'mx-rip.js');

function skip(message) {
    const error = new Error(message);
    error.skip = true;
    return error;
}

function findExistingPath(candidates) {
    for (const candidate of candidates) {
        if (!candidate || typeof candidate !== 'string') continue;
        const resolved = path.resolve(candidate);
        if (fs.existsSync(resolved)) return resolved;
    }
    return null;
}

function createTempOutputDir(name) {
    return path.join('/tmp', `mx-rip-regression-${name}-${Date.now()}-${process.pid}`);
}

function hasArtifactRef(member) {
    return Boolean(member && (member.image || member.scriptFile || member.paletteFile || member.text));
}

function countArtifactsByType(members, typeName, field) {
    return members.filter(member => member.type === typeName && member[field]).length;
}

function runExtractionFixture(name, inputPath, extraArgs = []) {
    const outputDir = createTempOutputDir(name);
    const args = [cliPath, inputPath, outputDir, '--force', ...extraArgs];
    const result = spawnSync(process.execPath, args, {
        cwd: repoRoot,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024
    });

    if (result.status !== 0) {
        throw new Error(
            `fixture extraction failed for ${name} (${inputPath})\n` +
            `status: ${result.status}\n` +
            `stdout:\n${result.stdout || ''}\n` +
            `stderr:\n${result.stderr || ''}\n` +
            `outputDir: ${outputDir}`
        );
    }

    const manifestPath = path.join(outputDir, 'members.json');
    if (!fs.existsSync(manifestPath)) {
        throw new Error(`fixture extraction for ${name} did not write members.json (${outputDir})`);
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return { outputDir, manifest };
}

module.exports = {
    repoRoot,
    skip,
    findExistingPath,
    hasArtifactRef,
    countArtifactsByType,
    runExtractionFixture
};
