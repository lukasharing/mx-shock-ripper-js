const { MemberType, Magic } = require('../Constants');

const CAST_METADATA_TAGS = [Magic.CAST, Magic.CAS_STAR, Magic.CArT, Magic.CAsT, Magic.cast_lower];
const TEXT_TAGS = [Magic.STXT, Magic.stxt_lower, Magic.TEXT, Magic.text_lower, Magic.TXTS];
const SOUND_TAGS = [Magic.SND, Magic.snd, Magic.SND_STAR, Magic.medi, Magic.ediM];
const PALETTE_TAGS = [Magic.CLUT, Magic.clut_lower, Magic.Palt, Magic.palt_lower, Magic.PALT_UPPER];
const BITMAP_TAGS = [Magic.BITD, Magic.bitd_lower, Magic.ABMP, Magic.DIB, Magic.DIB_STAR, Magic.PIXL, Magic.ILBM, Magic.MCrs];

const TYPE_CONTENT_TAGS = {
    [MemberType.Bitmap]: BITMAP_TAGS,
    [MemberType.FilmLoop]: CAST_METADATA_TAGS,
    [MemberType.Text]: TEXT_TAGS,
    [MemberType.Palette]: PALETTE_TAGS,
    [MemberType.Picture]: [Magic.PICT],
    [MemberType.Sound]: SOUND_TAGS,
    [MemberType.Button]: CAST_METADATA_TAGS,
    [MemberType.Shape]: [Magic.SHAP, ...CAST_METADATA_TAGS],
    [MemberType.Movie]: CAST_METADATA_TAGS,
    [MemberType.DigitalVideo]: [Magic.MooV, Magic.VdM],
    [MemberType.Script]: [Magic.LSCR, Magic.LSCR_UPPER, Magic.Lscl, Magic.rcsL],
    [MemberType.Field]: TEXT_TAGS,
    [MemberType.Transition]: CAST_METADATA_TAGS,
    [MemberType.Xtra]: [Magic.XTRA, Magic.XTCL],
    [MemberType.Font]: [Magic.FONT, Magic.VWFT],
    [MemberType.Mesh]: [],
    [MemberType.VectorShape]: [Magic.VCSH],
    [MemberType.Flash]: [Magic.Flas]
};

const TYPE_DETECTION_ORDER = [
    MemberType.Bitmap,
    MemberType.Palette,
    MemberType.Text,
    MemberType.Script,
    MemberType.Sound,
    MemberType.Xtra,
    MemberType.Shape,
    MemberType.Font,
    MemberType.DigitalVideo,
    MemberType.Flash,
    MemberType.Picture,
    MemberType.VectorShape,
    MemberType.Transition
];

function getContentTagsForType(typeId) {
    return TYPE_CONTENT_TAGS[typeId] ? [...TYPE_CONTENT_TAGS[typeId]] : [];
}

function isTransitionTag(tag) {
    return typeof tag === 'string' && tag.startsWith('Fx');
}

function tagMatchesType(tag, typeId) {
    if (!tag) return false;
    if (typeId === MemberType.Transition) return isTransitionTag(tag) || getContentTagsForType(typeId).includes(tag);
    return getContentTagsForType(typeId).includes(tag);
}

function getMatchingTagsForType(map, typeId) {
    if (!map) return [];
    const tags = Object.keys(map);
    return tags.filter(tag => tagMatchesType(tag, typeId));
}

function hasContentForType(map, typeId) {
    return getMatchingTagsForType(map, typeId).length > 0;
}

function getPreferredSectionId(map, typeId) {
    if (!map) return 0;

    for (const tag of getContentTagsForType(typeId)) {
        if (map[tag]) return map[tag];
    }

    if (typeId === MemberType.Transition) {
        const fxTag = Object.keys(map).find(tag => isTransitionTag(tag));
        if (fxTag && map[fxTag]) return map[fxTag];
    }

    return 0;
}

function detectMemberTypeFromMap(map) {
    if (!map) return null;
    for (const typeId of TYPE_DETECTION_ORDER) {
        if (hasContentForType(map, typeId)) return typeId;
    }
    return null;
}

function detectMemberTypeFromTag(tag) {
    if (!tag) return null;
    for (const typeId of TYPE_DETECTION_ORDER) {
        if (tagMatchesType(tag, typeId)) return typeId;
    }
    return null;
}

module.exports = {
    CAST_METADATA_TAGS,
    getContentTagsForType,
    getMatchingTagsForType,
    getPreferredSectionId,
    hasContentForType,
    detectMemberTypeFromMap,
    detectMemberTypeFromTag,
    isTransitionTag
};
