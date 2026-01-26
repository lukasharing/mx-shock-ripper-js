/**
 * @version 1.0.0
 * Opcode.js - Lingo bytecode mnemonics and mapping tables
 */

const ONE_BYTE_CODES = {
    0x00: "return", 0x01: "push_zero", 0x02: "push_one", 0x03: "push_minus_one",
    0x04: "add", 0x05: "sub", 0x06: "mul", 0x07: "div", 0x08: "mod", 0x09: "inv",
    0x0a: "join", 0x0b: "join_space", 0x0c: "less", 0x0d: "less_eq", 0x0e: "not_eq",
    0x0f: "eq", 0x10: "greater", 0x11: "greater_eq", 0x12: "and", 0x13: "or", 0x14: "not",
    0x15: "contains", 0x16: "starts_with", 0x17: "chunk_to_item", 0x18: "chunk_to_line",
    0x19: "exit_repeat", 0x1a: "next_repeat", 0x1e: "push_void", 0x1f: "push_empty_string"
};

const MULTI_BYTE_CODES = {
    0x01: "push_int8", 0x02: "push_int16", 0x03: "push_int32", 0x04: "push_float",
    0x05: "push_symbol", 0x06: "push_literal", 0x09: "push_handler", 0x0b: "push_global_prop",
    0x0c: "push_movie_prop", 0x0d: "push_prop", 0x0e: "push_global", 0x0f: "push_param",
    0x10: "push_local", 0x11: "pop_global_prop", 0x12: "pop_movie_prop", 0x13: "pop_prop",
    0x14: "pop_global", 0x15: "pop_param", 0x16: "pop_local", 0x17: "jump", 0x18: "jump_if_false",
    0x1b: "call_local", 0x1c: "call_external", 0x1d: "call_object", 0x20: "get_prop_local"
};

module.exports = {
    ONE_BYTE_CODES,
    MULTI_BYTE_CODES
};
