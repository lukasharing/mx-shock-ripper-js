/**
 * @version 1.3.0
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
    toString() { return ""; }
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

    toString(indent = "") {
        return this.statements.map(s => s.toString(indent)).filter(s => s !== "").join("\n");
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

    toString() {
        let s = `on ${this.name}`;
        if (this.args.length > 0) s += " " + this.args.join(", ");
        s += "\n";
        s += this.block.toString("  ");
        s += "\nend";
        return s;
    }
}

/**
 * Simple variable or property reference
 */
class VarReference extends Node {
    constructor(name) { super(); this.name = name; }
    toString() { return this.name; }
}

/**
 * Native property reference (e.g. the memberNum)
 */
class PropertyReference extends Node {
    constructor(name) { super(); this.name = name; }
    toString() { return this.name; }
}

/**
 * Local variable reference (l_1, l_2, etc or named locals)
 */
class LocalVarReference extends Node {
    constructor(name) { super(); this.name = name; }
    toString() { return this.name; }
}

/**
 * Command/Handler parameter reference
 */
class ParamReference extends Node {
    constructor(name) { super(); this.name = name; }
    toString() { return this.name; }
}

/**
 * Base class for constant values
 */
class Literal extends Node {
    constructor(value) { super(); this.value = value; }
    toString() { return String(this.value); }
}

class IntLiteral extends Literal { }
class FloatLiteral extends Literal { }
class StringLiteral extends Literal {
    toString() {
        if (!this.value) return '""';
        // Lingo uses \r for newlines in string literals
        let escaped = String(this.value)
            .replace(/\\/g, '\\\\')  // Escape backslashes first
            .replace(/"/g, '\\"')    // Escape quotes
            .replace(/\r/g, '\\r')   // Escape carriage returns
            .replace(/\n/g, '\\r');  // Convert newlines to \r
        return `"${escaped}"`;
    }
}
class SymbolLiteral extends Literal {
    toString() { return `#${this.value}`; }
}

/**
 * Array-style list: [1, 2, 3]
 */
class ListLiteral extends Node {
    constructor(items = []) { super(); this.items = items; }
    toString() { return "[" + this.items.map(i => i.toString()).join(", ") + "]"; }
}

/**
 * Keyed property list: [#a: 1, #b: 2]
 */
class PropListLiteral extends Node {
    constructor(items = []) { super(); this.items = items; }
    toString() {
        if (this.items.length === 0) return "[:]";
        const res = [];
        for (let i = 0; i < this.items.length; i += 2) {
            res.push(`${this.items[i]?.toString()}: ${this.items[i + 1]?.toString()}`);
        }
        return "[" + res.join(", ") + "]";
    }
}

/**
 * Internal representation of arguments for a call instruction
 */
class ArgListLiteral extends Node {
    constructor(value = []) { super(); this.value = value; }
}

/**
 * Assignment: target = value
 */
class AssignmentStatement extends Node {
    constructor(target, value) { super(); this.target = target; this.value = value; }
    toString(indent = "") {
        return `${indent}${this.target.toString()} = ${this.value.toString()}`;
    }
}

/**
 * Standard command or function call: name(args)
 */
class CallStatement extends Node {
    constructor(name, args) { super(); this.name = name; this.args = args; }
    toString(indent = "") {
        const argStr = (this.args instanceof ArgListLiteral) ? this.args.value.map(v => v.toString()).join(", ") : this.args?.toString();
        // Lingo commands like 'put' or 'alert' don't require parentheses
        const needsParens = !LingoConfig.COMMANDS_WITHOUT_PARENS.includes(this.name);
        return `${indent}${this.name}${needsParens ? "(" : " "}${argStr}${needsParens ? ")" : ""}`;
    }
}

/**
 * Member method call: object.method(args)
 */
class ObjCallStatement extends Node {
    constructor(target, method, args) { super(); this.target = target; this.method = method; this.args = args; }
    toString(indent = "") {
        const argStr = (this.args instanceof ArgListLiteral) ? this.args.value.map(v => v.toString()).join(", ") : this.args?.toString();
        return `${indent}${this.target.toString()}.${this.method}(${argStr})`;
    }
}

/**
 * Binary math and logic: 1 + 1, a = b, etc.
 */
class BinaryOperator extends Node {
    constructor(op, left, right) { super(); this.op = op; this.left = left; this.right = right; }
    toString() {
        let l = this.left?.toString();
        let r = this.right?.toString();

        // Recursively add parentheses for nested operation precedence
        if (this.left instanceof BinaryOperator || this.left instanceof LogicalOperator) l = `(${l})`;
        if (this.right instanceof BinaryOperator || this.right instanceof LogicalOperator) r = `(${r})`;

        // Dot operator (member access) doesn't have spaces
        if (this.op === '.') return `${l}.${r}`;
        if (this.op === '[]') return `${l}[${r}]`;
        return `${l} ${this.op} ${r}`;
    }
}

class LogicalOperator extends Node {
    constructor(op, left, right) { super(); this.op = op; this.left = left; this.right = right; }
    toString() {
        let l = this.left?.toString();
        let r = this.right?.toString();
        if (this.left instanceof LogicalOperator) l = `(${l})`;
        if (this.right instanceof LogicalOperator) r = `(${r})`;
        return `${l} ${this.op} ${r}`;
    }
}

/**
 * Unary operators: not cond, -value
 */
class NotOperator extends Node {
    constructor(expr) { super(); this.expr = expr; }
    toString() { return `not ${this.expr.toString()}`; }
}

class InverseOperator extends Node {
    constructor(expr) { super(); this.expr = expr; }
    toString() { return `-${this.expr.toString()}`; }
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

    toString(indent = "") {
        let s = `${indent}if ${this.cond?.toString()} then\n`;
        s += this.block1.toString(indent + "  ");
        if (this.type === 1) {
            s += `\n${indent}else\n`;
            s += this.block2.toString(indent + "  ");
        }
        s += `\n${indent}end if`;
        return s;
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

    toString(indent = "") {
        let s = `${indent}case ${this.expr?.toString()} of\n`;
        s += this.branches.map(b => b.toString(indent + "  ")).join("\n");
        s += `\n${indent}end case`;
        return s;
    }
}

class CaseBranch extends Node {
    constructor(labels = []) {
        super();
        this.labels = labels; // empty for 'otherwise'
        this.block = new Block(this);
    }

    toString(indent = "") {
        let s = indent;
        if (this.labels.length === 0) {
            s += "otherwise:";
        } else {
            s += this.labels.map(l => l.toString()).join(", ") + ":";
        }
        s += "\n";
        s += this.block.toString(indent + "  ");
        return s;
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
    toString(indent = "") {
        let s = `${indent}repeat with ${this.it} = ${this.start} ${this.down ? "down to" : "to"} ${this.end}\n`;
        s += this.block.toString(indent + "  ");
        s += `\n${indent}end repeat`;
        return s;
    }
}

class RepeatWhileStatement extends Node {
    constructor(cond) {
        super();
        this.cond = cond;
        this.block = new Block(this);
    }
    toString(indent = "") {
        let s = `${indent}repeat while ${this.cond}\n`;
        s += this.block.toString(indent + "  ");
        s += `\n${indent}end repeat`;
        return s;
    }
}

/**
 * Method return statement
 */
class ReturnStatement extends Node {
    constructor(value) { super(); this.value = value; }
    toString(indent = "") {
        return `${indent}return ${this.value?.toString() || ""}`;
    }
}

class ExitStatement extends Node {
    toString(indent = "") { return `${indent}exit`; }
}

/**
 * Placeholder for failed decompilation segments
 */
class ERROR extends Node {
    constructor(msg) { super(); this.msg = msg; }
    toString() { return `-- [DECOMPILE ERROR: ${this.msg}]`; }
}

module.exports = {
    Node, Block, Handler, VarReference, PropertyReference, LocalVarReference, ParamReference,
    Literal, IntLiteral, FloatLiteral, StringLiteral, SymbolLiteral,
    ListLiteral, PropListLiteral, ArgListLiteral, AssignmentStatement,
    CallStatement, ObjCallStatement, BinaryOperator, LogicalOperator,
    NotOperator, InverseOperator, IfStatement, CaseStatement, CaseBranch,
    RepeatWithStatement, RepeatWhileStatement,
    ReturnStatement, ExitStatement, ERROR
};
