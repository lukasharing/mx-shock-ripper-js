/**
 * @version 1.4.2
 * LingoAST.js
 * 
 * Abstract Syntax Tree (AST) nodes used to represent Lingo source code 
 * in memory.
 * 
 * See docs/doc/08_LingoAST.md for technical details.
 */

const { LingoConfig } = require('../Constants');

/**
 * Base Node class for all AST elements
 */
class Node {
    constructor() {
        this.parent = null;
    }
    // To be overridden by subclasses
    buildString(arr, indent = "") { }

    // Fallback for isolated legacy calls if any remain
    toString(indent = "") {
        const arr = [];
        this.buildString(arr, indent);
        return arr.join("");
    }
}

/**
 * A block containing multiple statements (e.g. inside an 'if' or 'on handler')
 */
class Block extends Node {
    constructor(parent = null) {
        super();
        this.parent = parent;
        this.statements = [];
        this.endPos = 0; // The bytecode position where this block must close
    }

    /**
     * Adds a statement to the block and sets its parent.
     */
    add(stmt) {
        if (stmt) {
            stmt.parent = this;
            this.statements.push(stmt);
        }
    }

    buildString(arr, indent = "") {
        for (let i = 0; i < this.statements.length; i++) {
            const stmt = this.statements[i];
            const startLen = arr.length;
            stmt.buildString(arr, indent);
            if (arr.length > startLen) {
                arr.push("\n");
            }
        }
    }
}

/**
 * Handler definition: on handlerName args... statements... end
 */
class Handler extends Node {
    constructor(name, args = []) {
        super();
        this.name = name;
        this.args = args;
        this.block = new Block(this);
    }

    buildString(arr, indent = "") {
        arr.push(`on ${this.name}`);
        if (this.args.length > 0) {
            arr.push(" ");
            arr.push(this.args.join(", "));
        }
        arr.push("\n");
        this.block.buildString(arr, indent + "  ");
        arr.push("end");
    }
}

/**
 * Simple variable or property reference
 */
class VarReference extends Node {
    constructor(name) { super(); this.name = name; }
    buildString(arr) { arr.push(this.name); }
}

/**
 * Native property reference (e.g. the memberNum)
 */
class PropertyReference extends Node {
    constructor(name) { super(); this.name = name; }
    buildString(arr) { arr.push(this.name); }
}

/**
 * Local variable reference (l_1, l_2, etc or named locals)
 */
class LocalVarReference extends Node {
    constructor(name) { super(); this.name = name; }
    buildString(arr) { arr.push(this.name); }
}

/**
 * Command/Handler parameter reference
 */
class ParamReference extends Node {
    constructor(name) { super(); this.name = name; }
    buildString(arr) { arr.push(this.name); }
}

/**
 * Base class for constant values
 */
class Literal extends Node {
    constructor(value) { super(); this.value = value; }
    buildString(arr) { arr.push(String(this.value)); }
}

class IntLiteral extends Literal { }
class FloatLiteral extends Literal { }
class StringLiteral extends Literal {
    buildString(arr) {
        if (!this.value) { arr.push('""'); return; }
        // Lingo uses \r for newlines in string literals
        let escaped = String(this.value)
            .replace(/\\/g, '\\\\')  // Escape backslashes first
            .replace(/"/g, '\\"')    // Escape quotes
            .replace(/\r/g, '\\r')   // Escape carriage returns
            .replace(/\n/g, '\\r');  // Convert newlines to \r
        arr.push(`"${escaped}"`);
    }
}
class SymbolLiteral extends Literal {
    buildString(arr) { arr.push(`#${this.value}`); }
}

/**
 * Array-style list: [1, 2, 3]
 */
class ListLiteral extends Node {
    constructor(items = []) { super(); this.items = items; }
    buildString(arr) {
        arr.push("[");
        for (let i = 0; i < this.items.length; i++) {
            this.items[i].buildString(arr);
            if (i < this.items.length - 1) arr.push(", ");
        }
        arr.push("]");
    }
}

/**
 * Keyed property list: [#a: 1, #b: 2]
 */
class PropListLiteral extends Node {
    constructor(items = []) { super(); this.items = items; }
    buildString(arr) {
        if (this.items.length === 0) {
            arr.push("[:]");
            return;
        }
        arr.push("[");
        for (let i = 0; i < this.items.length; i += 2) {
            if (this.items[i]) this.items[i].buildString(arr);
            arr.push(": ");
            if (this.items[i + 1]) this.items[i + 1].buildString(arr);
            if (i < this.items.length - 2) arr.push(", ");
        }
        arr.push("]");
    }
}

/**
 * Internal representation of arguments for a call instruction
 */
class ArgListLiteral extends Node {
    constructor(value = []) { super(); this.value = value; }
    buildString(arr) { } // ArgList should not be rendered directly, it's unpacked by caller
}

/**
 * Assignment: target = value
 */
class AssignmentStatement extends Node {
    constructor(target, value) { super(); this.target = target; this.value = value; }
    buildString(arr, indent = "") {
        arr.push(indent);
        this.target.buildString(arr);
        arr.push(" = ");
        this.value.buildString(arr);
    }
}

/**
 * Standard command or function call: name(args)
 */
class CallStatement extends Node {
    constructor(name, args) { super(); this.name = name; this.args = args; }
    buildString(arr, indent = "") {
        arr.push(indent);
        arr.push(this.name);
        const needsParens = !LingoConfig.COMMANDS_WITHOUT_PARENS.includes(this.name);
        arr.push(needsParens ? "(" : " ");

        if (this.args instanceof ArgListLiteral) {
            const vals = this.args.value;
            for (let i = 0; i < vals.length; i++) {
                vals[i].buildString(arr);
                if (i < vals.length - 1) arr.push(", ");
            }
        } else if (this.args) {
            this.args.buildString(arr);
        }

        if (needsParens) arr.push(")");
    }
}

/**
 * Member method call: object.method(args)
 */
class ObjCallStatement extends Node {
    constructor(target, method, args) { super(); this.target = target; this.method = method; this.args = args; }
    buildString(arr, indent = "") {
        arr.push(indent);
        this.target.buildString(arr);
        arr.push(".");
        arr.push(this.method);
        arr.push("(");

        if (this.args instanceof ArgListLiteral) {
            const vals = this.args.value;
            for (let i = 0; i < vals.length; i++) {
                vals[i].buildString(arr);
                if (i < vals.length - 1) arr.push(", ");
            }
        } else if (this.args) {
            this.args.buildString(arr);
        }

        arr.push(")");
    }
}

/**
 * Binary math and logic: 1 + 1, a = b, etc.
 */
class BinaryOperator extends Node {
    constructor(op, left, right) { super(); this.op = op; this.left = left; this.right = right; }
    buildString(arr) {
        const leftNeedsParens = (this.left instanceof BinaryOperator || this.left instanceof LogicalOperator);
        const rightNeedsParens = (this.right instanceof BinaryOperator || this.right instanceof LogicalOperator);

        if (this.op === '.') {
            if (leftNeedsParens) arr.push("(");
            if (this.left) this.left.buildString(arr);
            if (leftNeedsParens) arr.push(")");
            arr.push(".");
            if (rightNeedsParens) arr.push("(");
            if (this.right) this.right.buildString(arr);
            if (rightNeedsParens) arr.push(")");
            return;
        }
        if (this.op === '[]') {
            if (leftNeedsParens) arr.push("(");
            if (this.left) this.left.buildString(arr);
            if (leftNeedsParens) arr.push(")");
            arr.push("[");
            if (rightNeedsParens) arr.push("(");
            if (this.right) this.right.buildString(arr);
            if (rightNeedsParens) arr.push(")");
            arr.push("]");
            return;
        }

        if (leftNeedsParens) arr.push("(");
        if (this.left) this.left.buildString(arr);
        if (leftNeedsParens) arr.push(")");
        arr.push(` ${this.op} `);
        if (rightNeedsParens) arr.push("(");
        if (this.right) this.right.buildString(arr);
        if (rightNeedsParens) arr.push(")");
    }
}

class LogicalOperator extends Node {
    constructor(op, left, right) { super(); this.op = op; this.left = left; this.right = right; }
    buildString(arr) {
        const leftNeedsParens = (this.left instanceof LogicalOperator);
        const rightNeedsParens = (this.right instanceof LogicalOperator);

        if (leftNeedsParens) arr.push("(");
        if (this.left) this.left.buildString(arr);
        if (leftNeedsParens) arr.push(")");
        arr.push(` ${this.op} `);
        if (rightNeedsParens) arr.push("(");
        if (this.right) this.right.buildString(arr);
        if (rightNeedsParens) arr.push(")");
    }
}

/**
 * Unary operators: not cond, -value
 */
class NotOperator extends Node {
    constructor(expr) { super(); this.expr = expr; }
    buildString(arr) {
        arr.push("not ");
        if (this.expr) this.expr.buildString(arr);
    }
}

class InverseOperator extends Node {
    constructor(expr) { super(); this.expr = expr; }
    buildString(arr) {
        arr.push("-");
        if (this.expr) this.expr.buildString(arr);
    }
}

/**
 * Conditional control flow: if cond then ... else ... end if
 */
class IfStatement extends Node {
    constructor(type, cond) {
        super();
        this.type = type; // 0: IF, 1: IF-ELSE
        this.cond = cond;
        this.block1 = new Block(this);
        this.block2 = new Block(this);
    }

    setType(t) { this.type = t; }

    buildString(arr, indent = "") {
        arr.push(indent); arr.push("if ");
        if (this.cond) this.cond.buildString(arr);
        arr.push(" then\n");

        this.block1.buildString(arr, indent + "  ");

        if (this.type === 1) {
            arr.push(indent); arr.push("else\n");
            this.block2.buildString(arr, indent + "  ");
        }
        arr.push(indent); arr.push("end if");
    }
}

/**
 * Case statement: case expr of ... end case
 */
class CaseStatement extends Node {
    constructor(expr) {
        super();
        this.expr = expr;
        this.branches = [];
    }

    addBranch(branch) {
        branch.parent = this;
        this.branches.push(branch);
    }

    buildString(arr, indent = "") {
        arr.push(indent); arr.push("case ");
        if (this.expr) this.expr.buildString(arr);
        arr.push(" of\n");

        for (let i = 0; i < this.branches.length; i++) {
            this.branches[i].buildString(arr, indent + "  ");
            if (i < this.branches.length - 1) arr.push("\n");
        }

        arr.push("\n"); arr.push(indent); arr.push("end case");
    }
}

class CaseBranch extends Node {
    constructor(labels = []) {
        super();
        this.labels = labels; // empty for 'otherwise'
        this.block = new Block(this);
    }

    buildString(arr, indent = "") {
        arr.push(indent);
        if (this.labels.length === 0) {
            arr.push("otherwise:");
        } else {
            for (let i = 0; i < this.labels.length; i++) {
                this.labels[i].buildString(arr);
                if (i < this.labels.length - 1) arr.push(", ");
            }
            arr.push(":");
        }
        arr.push("\n");
        this.block.buildString(arr, indent + "  ");
    }
}

/**
 * Iteration: repeat with i = start to end ... end repeat
 */
class RepeatWithStatement extends Node {
    constructor(it, start, end, down = false) {
        super();
        this.it = it;
        this.start = start;
        this.end = end;
        this.down = down;
        this.block = new Block(this);
    }
    buildString(arr, indent = "") {
        arr.push(indent);
        arr.push(`repeat with ${this.it} = ${this.start} ${this.down ? "down to" : "to"} ${this.end}\n`);
        this.block.buildString(arr, indent + "  ");
        arr.push(indent); arr.push("end repeat");
    }
}

class RepeatWhileStatement extends Node {
    constructor(cond) {
        super();
        this.cond = cond;
        this.block = new Block(this);
    }
    buildString(arr, indent = "") {
        arr.push(indent); arr.push("repeat while ");
        if (this.cond) this.cond.buildString(arr);
        arr.push("\n");
        this.block.buildString(arr, indent + "  ");
        arr.push(indent); arr.push("end repeat");
    }
}

/**
 * Method return statement
 */
class ReturnStatement extends Node {
    constructor(value) { super(); this.value = value; }
    buildString(arr, indent = "") {
        arr.push(indent); arr.push("return ");
        if (this.value) this.value.buildString(arr);
    }
}

class ExitStatement extends Node {
    buildString(arr, indent = "") {
        arr.push(indent); arr.push("exit");
    }
}

class ExitRepeatStatement extends Node {
    buildString(arr, indent = "") {
        arr.push(indent); arr.push("exit repeat");
    }
}

/**
 * Reference to a member or field: field(id, castLib) or member(id, castLib)
 */
class MemberExpression extends Node {
    constructor(type, id, castLib = null) {
        super();
        this.type = type; // "field", "member", "cast", etc.
        this.id = id;
        this.castLib = castLib;
    }

    buildString(arr, indent = "") {
        arr.push(`${this.type} `);
        if (this.id) this.id.buildString(arr);
        if (this.castLib && this.castLib.toString() !== "0") {
            arr.push(` of castLib `);
            this.castLib.buildString(arr);
        }
    }
}

/**
 * Lingo chunk: char 1 to 5 of ...
 */
class ChunkExpression extends Node {
    constructor(type, start, end, base) {
        super();
        this.type = type; // 1: char, 2: word, 3: item, 4: line
        this.start = start;
        this.end = end;
        this.base = base;
    }

    buildString(arr, indent = "") {
        const types = { 1: "char", 2: "word", 3: "item", 4: "line" };
        arr.push(types[this.type] || "chunk");
        arr.push(" ");

        const s = this.start.toString();
        const e = this.end.toString();

        if (this.start) this.start.buildString(arr);
        if (s !== e) {
            arr.push(" to ");
            if (this.end) this.end.buildString(arr);
        }

        arr.push(" of ");
        if (this.base) this.base.buildString(arr);
    }
}

/**
 * Placeholder for failed decompilation segments
 */
class ERROR extends Node {
    constructor(msg) { super(); this.msg = msg; }
    buildString(arr, indent = "") {
        arr.push(`-- [DECOMPILE ERROR: ${this.msg}]`);
    }
}

module.exports = {
    Node, Block, Handler, VarReference, PropertyReference, LocalVarReference, ParamReference,
    Literal, IntLiteral, FloatLiteral, StringLiteral, SymbolLiteral,
    ListLiteral, PropListLiteral, ArgListLiteral, AssignmentStatement,
    CallStatement, ObjCallStatement, BinaryOperator, LogicalOperator,
    NotOperator, InverseOperator, IfStatement, CaseStatement, CaseBranch,
    RepeatWithStatement, RepeatWhileStatement,
    ReturnStatement, ExitStatement, ExitRepeatStatement, MemberExpression, ChunkExpression, ERROR
};
