const assert = require('assert/strict');

const KeyTableParser = require('../../src/utils/KeyTableParser');

function makeStandardKeyBuffer(entries) {
    const entrySize = 12;
    const headerSize = 12;
    const buffer = Buffer.alloc(headerSize + (entries.length * entrySize));

    buffer.writeUInt16BE(entrySize, 0);
    buffer.writeUInt16BE(entrySize, 2);
    buffer.writeUInt32BE(entries.length, 4);
    buffer.writeUInt32BE(entries.length, 8);

    entries.forEach((entry, index) => {
        const offset = headerSize + (index * entrySize);
        buffer.writeInt32BE(entry.sectionID, offset);
        buffer.writeInt32BE(entry.castID, offset + 4);
        buffer.write(entry.tag, offset + 8, 4, 'ascii');
    });

    return buffer;
}

function makeLegacyShortKeyBuffer(entries) {
    const entrySize = 8;
    const headerSize = 12;
    const buffer = Buffer.alloc(headerSize + (entries.length * entrySize));

    buffer.writeUInt16BE(headerSize, 0);
    buffer.writeUInt16BE(0, 2);
    buffer.writeUInt32BE(entries.length, 4);
    buffer.writeUInt32BE(entries.length, 8);

    entries.forEach((entry, index) => {
        const offset = headerSize + (index * entrySize);
        buffer.writeInt32BE(entry.sectionID, offset);
        buffer.write(entry.tag, offset + 4, 4, 'ascii');
    });

    return buffer;
}

module.exports = [
    {
        name: 'KeyTableParser parses standard 12-byte KEY entries',
        run() {
            const buffer = makeStandardKeyBuffer([
                { sectionID: 101, castID: 7, tag: 'BITD' },
                { sectionID: 202, castID: 8, tag: 'STXT' }
            ]);

            const parsed = KeyTableParser.parse(buffer, 'big');
            assert(parsed);
            assert.equal(parsed.layout.variant, 'standard');
            assert.equal(parsed.layout.entrySize, 12);
            assert.equal(parsed.entries.length, 2);
            assert.deepEqual(parsed.entries.map(entry => entry.castID), [7, 8]);
            assert.deepEqual(parsed.entries.map(entry => entry.tag), ['BITD', 'STXT']);
        }
    },
    {
        name: 'KeyTableParser parses legacy short KEY entries and unprotects tags',
        run() {
            const buffer = makeLegacyShortKeyBuffer([
                { sectionID: 301, tag: 'DTIB' },
                { sectionID: 302, tag: 'TULC' }
            ]);

            const parsed = KeyTableParser.parse(buffer, 'big');
            assert(parsed);
            assert.equal(parsed.layout.variant, 'legacy-short');
            assert.equal(parsed.entries.length, 2);
            assert.deepEqual(parsed.entries.map(entry => entry.castID), [1, 2]);
            assert.deepEqual(parsed.entries.map(entry => entry.tag), ['BITD', 'CLUT']);
        }
    },
    {
        name: 'KeyTableParser reports invalid layouts instead of silently parsing garbage',
        run() {
            const warnings = [];
            const parsed = KeyTableParser.parse(Buffer.from('000102030405', 'hex'), 'big', (level, message) => {
                warnings.push({ level, message });
            });

            assert.equal(parsed, null);
            assert.equal(warnings.length, 1);
            assert.equal(warnings[0].level, 'WARNING');
            assert.match(warnings[0].message, /could not determine a valid layout/i);
        }
    }
];
