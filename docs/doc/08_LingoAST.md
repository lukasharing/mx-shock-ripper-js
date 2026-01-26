# Lingo AST: Structural Recovery and Serialization

This document describes the Abstract Syntax Tree (AST) implementation used to represent Lingo source code during the decompilation process.

## Architecture

The AST follows a traditional node-based hierarchy:

- **Base Node**: Every element (from a literal integer to a full handler) inherits from the base `Node` class.
- **Block Management**: The `Block` node manages collections of statements, handling jump targets and indentation.
- **Serialization**: Each node implements a `toString()` method that recursively converts the tree into valid Lingo source syntax.

## Recovery Phases

The `LingoDecompiler` populates the AST using several specialized recovery techniques:

1. **Statement Recovery**: Reconstructs complete statements from the bytecode stream, including handling "no-return" push operations (`pusharglistnoret`).
2. **Control Flow Reconstruction**:
    - **Conditionals**: Nested `if/else` and `case` structures are recovered by monitoring jump targets (`jmp`, `jmpifz`).
    - **Loops**: `repeat with` and `repeat while` loops are reconstructed by identifying backward jumps and loop variable initialization.
3. **Precedence and Nesting**: The AST manages operator precedence (e.g., adding parentheses for math/logic) and scoping (block nesting).

## Node Types

- **Literals**: Handles Strings (with Lingo-specific escapes), Integers, Floats, and Symbols.
- **References**: Manages Globals, Locals, Parameters, and Sprite Properties.
- **Operations**: Supports Binary (math), Logical (and/or/not), and Object Access (dot notation).
- **Procedures**: Represents Handlers (`on handlerName ... end`) and Call statements.
