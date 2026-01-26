/**
 * @version 1.1.1
 * Config.js - General configuration and structural thresholds for Lingo
 */

module.exports = {
    HeuristicName: "new",
    OP_SHIFT_THRESHOLD: 0x40,
    V4_HLEN: 92,
    SPECIAL_IDS: {
        TRACE_SCRIPT: 1117,
        PLAYER: 988,
        MOVIE: 1118,
        TYPE: 111,
        EXT_CALL_MAGIC: 26
    },
    V4_SPRITE_PROPS: {
        0x01: 'spriteNum',
        0x06: 'member',
        0x07: 'visible',
        0x08: 'locZ',
        0x09: 'blend',
        0x0f: 'loc',
        0x15: 'rect'
    },
    SCRIPT_TYPE: {
        SCORE: 1,
        PARENT: 3,
        CAST: 4,
        LEGACY_PARENT: 6,
        LEGACY_BEHAVIOR: 7,
        LEGACY_CAST: 8
    },
    LITERAL_TYPE: {
        STRING: 1,
        INT: 2,
        FLOAT: 3,
        SYMBOL: 4,
        LIST: 5
    },
    COMMANDS_WITHOUT_PARENS: ['put', 'alert', 'set', 'go'],
    Labels: {
        ProtectedScript: "[Protected Script]"
    }
};
