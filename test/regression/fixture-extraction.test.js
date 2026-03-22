const assert = require('assert/strict');
const fs = require('fs');

const {
    skip,
    findExistingPath,
    hasArtifactRef,
    countArtifactsByType,
    runExtractionFixture
} = require('./helpers');

const DEFAULT_FIXTURE_PATHS = {
    fuse_client: [
        process.env.MX_FIXTURE_FUSE_CLIENT,
        '/Users/lukasharing/Documents/HabboDecomp/fuse_client.cct'
    ],
    hh_ig_interface: [
        process.env.MX_FIXTURE_HH_IG_INTERFACE
    ]
};

const FIXTURE_EXPECTATIONS = {
    fuse_client: {
        minDiscovered: 5000,
        minSelected: 5000,
        maxDropped: 10
    },
    hh_ig_interface: {
        minDiscovered: 300,
        minSelected: 300,
        maxDropped: 20
    }
};

function assertFixtureManifest(name, manifest, expectations) {
    assert(manifest.stats, `${name}: missing stats in members.json`);
    assert(Array.isArray(manifest.members), `${name}: missing members array`);

    const discovered = manifest.stats.discovered?.total || 0;
    const selected = manifest.stats.selected?.total || 0;
    const extracted = manifest.stats.extracted?.total || 0;
    const skipped = manifest.stats.skipped?.total || 0;
    const failed = manifest.stats.failed?.total || 0;
    const dropped = discovered - selected;

    assert(discovered >= expectations.minDiscovered, `${name}: discovered ${discovered} < ${expectations.minDiscovered}`);
    assert(selected >= expectations.minSelected, `${name}: selected ${selected} < ${expectations.minSelected}`);
    assert(dropped >= 0, `${name}: selected exceeds discovered`);
    assert(dropped <= expectations.maxDropped, `${name}: dropped ${dropped} > ${expectations.maxDropped}`);
    assert.equal(selected, extracted + skipped + failed, `${name}: selected/extracted/skipped/failed accounting mismatch`);

    const extractedMembers = manifest.members.filter(member => member.outcome === 'extracted');
    const extractedWithoutArtifacts = extractedMembers.filter(member => !hasArtifactRef(member));
    assert.equal(extractedWithoutArtifacts.length, 0, `${name}: extracted members without artifact refs: ${extractedWithoutArtifacts.slice(0, 5).map(member => member.id).join(', ')}`);

    const bitmapArtifacts = countArtifactsByType(manifest.members, 'Bitmap', 'image');
    const scriptArtifacts = countArtifactsByType(manifest.members, 'Script', 'scriptFile');
    const paletteArtifacts = countArtifactsByType(manifest.members, 'Palette', 'paletteFile');
    const textArtifacts = countArtifactsByType(manifest.members, 'Text', 'image') + countArtifactsByType(manifest.members, 'Field', 'image');

    if ((manifest.stats.discovered?.byType?.Bitmap || 0) > 0) assert(bitmapArtifacts > 0, `${name}: discovered bitmaps but emitted no bitmap artifacts`);
    if ((manifest.stats.discovered?.byType?.Script || 0) > 0) assert(scriptArtifacts > 0, `${name}: discovered scripts but emitted no script artifacts`);
    if ((manifest.stats.discovered?.byType?.Palette || 0) > 0) assert(paletteArtifacts > 0, `${name}: discovered palettes but emitted no palette artifacts`);
    if (((manifest.stats.discovered?.byType?.Text || 0) + (manifest.stats.discovered?.byType?.Field || 0)) > 0) {
        assert(textArtifacts > 0, `${name}: discovered text/field members but emitted no text artifacts`);
    }
}

function buildFixtureTests() {
    return Object.entries(FIXTURE_EXPECTATIONS).map(([name, expectations]) => ({
        name: `Fixture extraction preserves discovered vs selected coverage for ${name}`,
        run() {
            const inputPath = findExistingPath(DEFAULT_FIXTURE_PATHS[name] || []);
            if (!inputPath) {
                throw skip(`${name} fixture not found. Set ${name === 'fuse_client' ? 'MX_FIXTURE_FUSE_CLIENT' : 'MX_FIXTURE_HH_IG_INTERFACE'} to enable this test.`);
            }

            const { outputDir, manifest } = runExtractionFixture(name, inputPath);
            let passed = false;
            try {
                assertFixtureManifest(name, manifest, expectations);
                passed = true;
            } catch (error) {
                error.message = `${error.message}\noutputDir: ${outputDir}`;
                throw error;
            } finally {
                if (passed) {
                    fs.rmSync(outputDir, { recursive: true, force: true });
                }
            }
        }
    }));
}

module.exports = buildFixtureTests();
