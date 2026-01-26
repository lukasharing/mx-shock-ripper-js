/**
 * @version 1.1.5
 * Constants.js - Centralized export hub for all technical constants
 */

const MemberType = require('./constants/MemberType');
const HeaderSize = require('./constants/HeaderSize');
const Limits = require('./constants/Limits');
const Magic = require('./constants/Magic');
const AfterburnerTags = require('./constants/Afterburner');
const KeyTableValues = require('./constants/KeyTable');
const Bitmap = require('./constants/Bitmap');
const Sound = require('./constants/Sound');
const Font = require('./constants/Font');
const Resources = require('./constants/Resources');
const LingoConfig = require('./constants/lingo/Config');
const LingoOpcode = require('./constants/lingo/Opcode');
const Offsets = require('./constants/Offsets');

module.exports = {
    MemberType,
    HeaderSize,
    Limits,
    Magic,
    AfterburnerTags,
    KeyTableValues,
    Bitmap,
    Sound,
    Font,
    Resources,
    LingoConfig,
    LingoOpcode,
    Offsets
};
