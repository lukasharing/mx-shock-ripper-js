/**
 * @version 1.0.0
 * Config.js - General configuration and structural thresholds for Lingo
 */

module.exports = {
    HeuristicName: "new",
    OP_SHIFT_THRESHOLD: 0x40,
    VERSION_V4: 92,
    SPECIAL_IDS: {
        TRACE_SCRIPT: 0x00,
        PLAYER: 0x01,
        MOVIE: 0x02,
        EXT_CALL_MAGIC: 0xFFFF
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
