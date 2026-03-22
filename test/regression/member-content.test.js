const assert = require('assert/strict');

const { MemberType, Magic } = require('../../src/Constants');
const {
    getContentTagsForType,
    getMatchingTagsForType,
    getPreferredSectionId,
    detectMemberTypeFromMap,
    detectMemberTypeFromTag,
    isTransitionTag
} = require('../../src/utils/MemberContent');

module.exports = [
    {
        name: 'MemberContent canonical bitmap tags cover protected and alternate payloads',
        run() {
            const tags = getContentTagsForType(MemberType.Bitmap);
            assert(tags.includes(Magic.BITD));
            assert(tags.includes(Magic.ABMP));
            assert(tags.includes(Magic.PIXL));
            assert(tags.includes(Magic.ILBM));
            assert(tags.includes(Magic.MCrs));
        }
    },
    {
        name: 'MemberContent detects common member types from tags and maps',
        run() {
            assert.equal(detectMemberTypeFromTag(Magic.Lscl), MemberType.Script);
            assert.equal(detectMemberTypeFromTag(Magic.TXTS), MemberType.Text);
            assert.equal(detectMemberTypeFromTag(Magic.PICT), MemberType.Picture);
            assert.equal(detectMemberTypeFromTag(Magic.FONT), MemberType.Font);
            assert.equal(detectMemberTypeFromTag(Magic.XTRA), MemberType.Xtra);
            assert.equal(detectMemberTypeFromTag(Magic.MooV), MemberType.DigitalVideo);
            assert.equal(detectMemberTypeFromTag(Magic.Flas), MemberType.Flash);
            assert.equal(detectMemberTypeFromMap({ [Magic.ABMP]: 17 }), MemberType.Bitmap);
            assert.equal(detectMemberTypeFromMap({ [Magic.TEXT]: 33 }), MemberType.Text);
        }
    },
    {
        name: 'MemberContent selects matching and preferred tags consistently',
        run() {
            const bitmapMap = {
                [Magic.CAST]: 1,
                [Magic.ABMP]: 20,
                [Magic.BITD]: 10
            };

            assert.deepEqual(getMatchingTagsForType(bitmapMap, MemberType.Bitmap), [Magic.ABMP, Magic.BITD]);
            assert.equal(getPreferredSectionId(bitmapMap, MemberType.Bitmap), 10);
            assert.equal(getPreferredSectionId({ [Magic.ABMP]: 20 }, MemberType.Bitmap), 20);
        }
    },
    {
        name: 'MemberContent recognizes transition Fx tags',
        run() {
            assert.equal(isTransitionTag('Fx01'), true);
            assert.equal(isTransitionTag('Fx??'), true);
            assert.equal(isTransitionTag(Magic.CAST), false);
            assert.equal(detectMemberTypeFromTag('Fx22'), MemberType.Transition);
        }
    }
];
