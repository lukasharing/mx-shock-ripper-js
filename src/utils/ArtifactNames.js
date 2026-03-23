function sanitizeArtifactStem(name, fallback = 'artifact') {
    const raw = String(name || '').trim() || fallback;
    const safe = raw.replace(/[/\\?%*:|"<>]/g, '_').trim();
    return safe || fallback;
}

function getAnonymousScriptTypeLabel(scriptType) {
    switch (scriptType) {
        case 1:
            return 'BehaviorScript';
        case 2:
            return 'ParentScript';
        case 7:
            return 'CastScript';
        case 0:
        case 3:
            return 'MovieScript';
        default:
            return 'UnknownScript';
    }
}

function buildScriptArtifactStem(name, memberId, scriptType = null) {
    const rawFallback = `member_${memberId}`;
    const anonymousFallback = scriptType === null || scriptType === undefined
        ? rawFallback
        : `${getAnonymousScriptTypeLabel(scriptType)}__${memberId}`;
    const safeName = sanitizeArtifactStem(name, rawFallback);
    if (safeName === rawFallback) return anonymousFallback;
    return `${safeName}__${memberId}`;
}

module.exports = {
    sanitizeArtifactStem,
    buildScriptArtifactStem,
    getAnonymousScriptTypeLabel
};
