const { MemberType } = require('../Constants');

const ARTIFACT_FIELDS = [
    'image',
    'scriptFile',
    'paletteFile',
    'textFile',
    'soundFile',
    'dataFile'
];

function getPrimaryArtifactField(typeId) {
    switch (typeId) {
        case MemberType.Bitmap:
        case MemberType.Shape:
        case MemberType.VectorShape:
        case MemberType.Picture:
            return 'image';
        case MemberType.Script:
            return 'scriptFile';
        case MemberType.Palette:
            return 'paletteFile';
        case MemberType.Text:
        case MemberType.Field:
            return 'textFile';
        case MemberType.Sound:
            return 'soundFile';
        default:
            return 'dataFile';
    }
}

function clearArtifactFields(member) {
    if (!member) return;
    for (const field of ARTIFACT_FIELDS) {
        member[field] = null;
    }
}

function assignArtifactToMember(member, file) {
    if (!member) return null;
    clearArtifactFields(member);
    if (!file) return null;
    const field = getPrimaryArtifactField(member.typeId);
    member[field] = file;
    return field;
}

function getArtifactSnapshot(member) {
    const snapshot = {};
    if (!member) return snapshot;
    for (const field of ARTIFACT_FIELDS) {
        if (member[field]) snapshot[field] = member[field];
    }
    return snapshot;
}

function restoreArtifactsToMember(member, record) {
    if (!member) return;
    clearArtifactFields(member);
    if (!record) return;

    const primaryField = getPrimaryArtifactField(member.typeId);
    const primaryValue = record[primaryField] || (
        primaryField !== 'image' ? record.image : null
    );

    if (primaryValue) {
        member[primaryField] = primaryValue;
    }
}

function migrateLegacyArtifactRecord(record) {
    if (!record || !record.typeId) return record;
    const primaryField = getPrimaryArtifactField(record.typeId);
    if (primaryField !== 'image' && !record[primaryField] && record.image) {
        record[primaryField] = record.image;
    }
    if (primaryField !== 'image') {
        delete record.image;
    }
    return record;
}

function hasArtifact(member) {
    if (!member) return false;
    return ARTIFACT_FIELDS.some(field => !!member[field]);
}

module.exports = {
    ARTIFACT_FIELDS,
    assignArtifactToMember,
    clearArtifactFields,
    getArtifactSnapshot,
    getPrimaryArtifactField,
    hasArtifact,
    migrateLegacyArtifactRecord,
    restoreArtifactsToMember
};
