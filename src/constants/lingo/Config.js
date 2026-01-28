/**
 * @version 1.2.7
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
        0x00: 'type',
        0x01: 'spriteNum',
        0x02: 'foreColor',
        0x03: 'backColor',
        0x04: 'startFrame',
        0x05: 'endFrame',
        0x06: 'member',
        0x07: 'visible',
        0x08: 'ink',
        0x09: 'blend',
        0x0a: 'script',
        0x0b: 'scriptNum',
        0x0f: 'loc',
        0x10: 'scoreColor',
        0x15: 'rect',
        0x16: 'width',
        0x17: 'height'
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
    },
    OP_SPEC: {
        PUSHVAR: 0x01,
        MOVIEPROP: 0x1f,
        GETTOPLEVELPROP: 0x32
    }
};
