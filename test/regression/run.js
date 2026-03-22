const path = require('path');

const memberContentTests = require('./member-content.test');
const keyTableParserTests = require('./key-table-parser.test');
const fixtureExtractionTests = require('./fixture-extraction.test');

const args = new Set(process.argv.slice(2));
const runUnits = !args.has('--fixtures-only');
const runFixtures = !args.has('--unit-only');

const tests = [];
if (runUnits) tests.push(...memberContentTests, ...keyTableParserTests);
if (runFixtures) tests.push(...fixtureExtractionTests);

async function runTest(test) {
    await test.run();
}

(async () => {
    let passed = 0;
    let skipped = 0;
    let failed = 0;

    for (const test of tests) {
        const start = Date.now();
        try {
            await runTest(test);
            const elapsed = Date.now() - start;
            console.log(`PASS ${test.name} (${elapsed}ms)`);
            passed++;
        } catch (error) {
            if (error && error.skip) {
                console.log(`SKIP ${test.name}: ${error.message}`);
                skipped++;
                continue;
            }

            console.error(`FAIL ${test.name}`);
            console.error(error && error.stack ? error.stack : String(error));
            failed++;
        }
    }

    const summary = `Summary: ${passed} passed, ${skipped} skipped, ${failed} failed`;
    if (failed > 0) {
        console.error(summary);
        process.exit(1);
    }

    console.log(summary);
})();
