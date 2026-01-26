/**
 * @version 1.0.0
 * LingoAST.js - Abstract Syntax Tree nodes for Adobe Director Lingo
 * 
 * Defines the object-oriented structure for representing Lingo source code parts. 
 * Handles serialization to human-readable code with appropriate indentation and syntax rules.
 */

/**
 * Base Node class providing core serialization and relationship plumbing.
 */
class Node {
    constructor() { this.parent = null; }
    toString() { return ""; }
    static safe(node, indent = "") {
        if (!node) return "";
        return (typeof node === 'string') ? node : node.toString(indent);
    }
}

/**
 * Block - Container for sequential statements, handles scope indentation.
 */
class Block extends Node {
    constructor(parent = null) {
        super();
        this.parent = parent;
        this.statements = [];
        this.endPos = 0;
    }
    add(stmt) { if (stmt) { stmt.parent = this; this.statements.push(stmt); } }
    toString(indent = "") {
        return this.statements.map(s => Node.safe(s, indent)).filter(s => s !== "").join("\n");
    }
}

/**
 * Handler - Represents a Lingo event handler or function.
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
        return `${s}\n${this.block.toString("  ")}\nend`;
    }
}

class VarReference extends Node { constructor(name) { super(); this.name = name; } toString() { return this.name; } }
class Literal extends Node { constructor(val) { super(); this.val = val; } toString() { return String(this.val); } }
class StringLiteral extends Literal { toString() { return `"${this.val}"`; } }
class SymbolLiteral extends Literal { toString() { return `#${this.val}`; } }

class ListLiteral extends Node {
    constructor(items = []) { super(); this.items = items; }
    toString() { return "[" + this.items.map(i => Node.safe(i)).join(", ") + "]"; }
}

class PropListLiteral extends Node {
    constructor(items = []) { super(); this.items = items; }
    toString() {
        if (this.items.length === 0) return "[:]";
        let res = [];
        for (let i = 0; i < this.items.length; i += 2) {
            res.push(`${Node.safe(this.items[i])}: ${Node.safe(this.items[i + 1])}`);
        }
        return "[" + res.join(", ") + "]";
    }
}

class AssignmentStatement extends Node {
    constructor(target, val) { super(); this.target = target; this.val = val; }
    toString(indent = "") { return `${indent}${Node.safe(this.target)} = ${Node.safe(this.val)}`; }
}

class CallStatement extends Node {
    constructor(name, args) { super(); this.name = name; this.args = args; }
    toString(indent = "") {
        const argStr = Array.isArray(this.args) ? this.args.map(a => Node.safe(a)).join(", ") : Node.safe(this.args);
        return `${indent}${this.name}(${argStr})`;
    }
}

class BinaryOperator extends Node {
    constructor(op, left, right) { super(); this.op = op; this.left = left; this.right = right; }
    toString() {
        const l = Node.safe(this.left);
        const r = Node.safe(this.right);
        if (this.op === '.') return `${l}.${r}`;
        return `${l} ${this.op} ${r}`;
    }
}

class IfStatement extends Node {
    constructor(cond) { super(); this.cond = cond; this.block1 = new Block(this); this.block2 = new Block(this); this.hasElse = false; }
    toString(indent = "") {
        let s = `${indent}if ${Node.safe(this.cond)} then\n${this.block1.toString(indent + "  ")}`;
        if (this.hasElse) s += `\n${indent}else\n${this.block2.toString(indent + "  ")}`;
        return s + `\n${indent}end if`;
    }
}

class RepeatWithStatement extends Node {
    constructor(v, s, e) { super(); this.v = v; this.s = s; this.e = e; this.block = new Block(this); }
    toString(indent = "") {
        return `${indent}repeat with ${this.v} = ${Node.safe(this.s)} to ${Node.safe(this.e)}\n${this.block.toString(indent + "  ")}\n${indent}end repeat`;
    }
}

class ReturnStatement extends Node {
    constructor(val) { super(); this.val = val; }
    toString(indent = "") { return this.val ? `${indent}return ${Node.safe(this.val)}` : `${indent}return`; }
}

module.exports = {
    Node, Block, Handler, VarReference, Literal, StringLiteral, SymbolLiteral,
    ListLiteral, PropListLiteral, AssignmentStatement, CallStatement,
    BinaryOperator, IfStatement, RepeatWithStatement, ReturnStatement
};
