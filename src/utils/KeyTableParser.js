const DataStream = require('./DataStream');
const DirectorFile = require('../DirectorFile');
const { Offsets, KeyTableValues } = require('../Constants');

function validateLayout(data, headerSize, entrySize, entryCount, usedCount) {
    if (!Number.isInteger(headerSize) || !Number.isInteger(entrySize)) return false;
    if (headerSize < 0 || entrySize < Offsets.KeyEntryShort) return false;
    if (!Number.isInteger(entryCount) || !Number.isInteger(usedCount)) return false;
    if (entryCount <= 0 || usedCount < 0 || usedCount > entryCount) return false;
    if (headerSize + (entryCount * entrySize) > data.length) return false;
    return true;
}

function detectStandardLayout(data, endianness) {
    if (data.length < Offsets.KeyTableShort) return null;

    const ds = new DataStream(data, endianness);
    const entrySize = ds.readUint16();
    const entrySize2 = ds.readUint16();
    const entryCount = ds.readUint32();
    const usedCount = ds.readUint32();

    if (!validateLayout(data, Offsets.KeyTableShort, entrySize, entryCount, usedCount)) {
        return null;
    }

    return {
        endianness,
        headerSize: Offsets.KeyTableShort,
        entrySize,
        entrySize2,
        entryCount,
        usedCount,
        variant: 'standard'
    };
}

function detectLegacyLayout(data, endianness) {
    if (data.length < Offsets.KeyTableShort) return null;

    const ds = new DataStream(data, endianness);
    const firstWord = ds.readUint16();
    const candidateHeaderSizes = [];

    if (firstWord === KeyTableValues.HeaderShort) candidateHeaderSizes.push(Offsets.KeyTableShort);
    if (firstWord === 0x0114 || firstWord === 0x1401 || firstWord === KeyTableValues.HeaderLong) candidateHeaderSizes.push(Offsets.KeyTableStandard);
    if (!candidateHeaderSizes.includes(Offsets.KeyTableStandard)) candidateHeaderSizes.push(Offsets.KeyTableStandard);
    if (!candidateHeaderSizes.includes(Offsets.KeyTableShort)) candidateHeaderSizes.push(Offsets.KeyTableShort);

    for (const headerSize of candidateHeaderSizes) {
        if (headerSize === Offsets.KeyTableShort && data.length >= Offsets.KeyTableShort) {
            ds.seek(4);
            const entryCount = ds.readUint32();
            const usedCount = ds.readUint32();
            if (validateLayout(data, headerSize, Offsets.KeyEntryShort, entryCount, usedCount)) {
                return {
                    endianness,
                    headerSize,
                    entrySize: Offsets.KeyEntryShort,
                    entrySize2: Offsets.KeyEntryShort,
                    entryCount,
                    usedCount,
                    variant: 'legacy-short'
                };
            }
        }

        if (headerSize === Offsets.KeyTableStandard && data.length >= Offsets.KeyTableStandard) {
            ds.seek(12);
            const entryCount = ds.readUint32();
            const usedCount = ds.readUint32();
            if (validateLayout(data, headerSize, Offsets.KeyEntryStandard, entryCount, usedCount)) {
                return {
                    endianness,
                    headerSize,
                    entrySize: Offsets.KeyEntryStandard,
                    entrySize2: Offsets.KeyEntryStandard,
                    entryCount,
                    usedCount,
                    variant: 'legacy-standard'
                };
            }
        }
    }

    return null;
}

function detectLayout(data, preferredEndianness = 'big') {
    const candidates = [
        detectStandardLayout(data, preferredEndianness),
        detectStandardLayout(data, preferredEndianness === 'big' ? 'little' : 'big'),
        detectLegacyLayout(data, preferredEndianness),
        detectLegacyLayout(data, preferredEndianness === 'big' ? 'little' : 'big')
    ].filter(Boolean);

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => {
        if (b.usedCount !== a.usedCount) return b.usedCount - a.usedCount;
        if (b.entryCount !== a.entryCount) return b.entryCount - a.entryCount;
        return a.headerSize - b.headerSize;
    });

    return candidates[0];
}

function parse(data, preferredEndianness = 'big', log = null) {
    const layout = detectLayout(data, preferredEndianness);
    if (!layout) {
        if (typeof log === 'function') {
            log('WARNING', `KEY* parser could not determine a valid layout for ${data.length} bytes.`);
        }
        return null;
    }

    const ds = new DataStream(data, layout.endianness);
    ds.seek(layout.headerSize);

    if (typeof log === 'function' && ![Offsets.KeyEntryShort, Offsets.KeyEntryStandard].includes(layout.entrySize)) {
        log('WARNING', `KEY* entry size ${layout.entrySize} is non-standard; parsing the first 12 bytes of each entry and skipping the remainder.`);
    }

    const entries = [];
    for (let i = 0; i < layout.usedCount; i++) {
        const entryStart = ds.position;
        if (entryStart + layout.entrySize > data.length) {
            if (typeof log === 'function') {
                log('WARNING', `KEY* entry ${i} exceeds buffer bounds at ${entryStart} (entrySize=${layout.entrySize}, dataLen=${data.length}).`);
            }
            break;
        }

        const sectionID = ds.readInt32();
        let castID = i + 1;
        let tag = null;

        if (layout.entrySize >= Offsets.KeyEntryStandard) {
            castID = ds.readInt32();
            tag = DirectorFile.unprotect(ds.readFourCC());
        } else if (layout.entrySize === Offsets.KeyEntryShort) {
            tag = DirectorFile.unprotect(ds.readFourCC());
        } else {
            if (typeof log === 'function') {
                log('WARNING', `KEY* entry ${i} has unsupported short size ${layout.entrySize}; stopping parse.`);
            }
            break;
        }

        entries.push({ index: i, sectionID, castID, tag });
        ds.seek(entryStart + layout.entrySize);
    }

    return { layout, entries };
}

module.exports = {
    parse
};
