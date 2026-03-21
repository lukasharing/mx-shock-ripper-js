# Lingo Decompiler

This document describes the current decompiler model in `src/lingo/LingoDecompiler.js`.

## Name Table Selection

Director files can contain multiple `Lnam` chunks. The extractor chooses the active name table in two stages:

1. Prefer the `Lctx`-linked `Lnam` when `MetadataManager` can map the script logically.
2. Fall back to the nearest preceding `Lnam` in physical chunk order.

That is the current replacement for the older `traceScript`-probe workflow. The `traceScript` calibration heuristic is no longer part of the intended design.

## Calibration Model

The active calibration logic is intentionally narrower than older versions:

- handler names use a relative shift derived from the first `HAND` entry
- the usual anchor names are `new` and `construct`
- global and movie-property shifts currently default to zero unless future logic overrides them

The implementation still applies a small set of hard-coded Shockwave-oriented symbol overrides for names such as `_movie`, `_player`, `traceScript`, and `type`. That is a pragmatic compatibility layer, not a general Director truth.

## Internal Call Resolution

`localcall` is resolved by handler-table index, not by `Lnam` symbol ID. The decompiler reads the current script's `HAND` table and maps the target entry back to a handler name.

This matches the behavior seen in ProjectorRays and ScummVM for modern Lingo bytecode.

## AST Reconstruction

The bytecode translator is stack-based:

- literals are loaded from `LIT ` / `LTD `
- property declarations come from `PROP`
- handlers come from `HAND`
- each handler is translated into AST nodes and then serialized back to Lingo source

Recovered structures include:

- handler definitions
- `if` / `else`
- `case`
- `repeat while`
- common calls, assignments, and property access

## Director 4 / Legacy Support

Legacy V4 scripts use a different handler table layout and distinct `get` / `set` property opcodes. The decompiler has a dedicated V4 path with a fixed handler entry size and a manual legacy property map.

## Current Caveats

The decompiler is usable, but not complete. Known weak points today include:

- ad hoc symbol overrides through `SPECIAL_IDS`
- incomplete V4 property coverage
- object-call reconstruction in some edge cases
- variable recovery failures that can still produce translation warnings on malformed or unusual bytecode

## Script Outputs

The standard CLI script output is:

- `.ls`: decompiled source
- `.lasm`: optional assembly-style dump when `--lasm` is enabled
