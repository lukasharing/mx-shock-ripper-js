/**
 * @version 1.1.2
 * LingoAST.js - Abstract Syntax Tree nodes and Translation Engine for Adobe Director Lingo
 * 
 * Defines the structural building blocks for Lingo source code and implements the 
 * state-machine for transforming bytecode instructions into a hierarchical tree.
 */

const { LingoConfig } = require('../Constants');

/**
 * Base Node class for all AST elements
 */
class Node {
    constructor() {
        this.parent = null;
    }
    toString() { return ""; }

    static safe(node, indent = "") {
        if (!node) return "-- [NULL]";
        if (typeof node === 'string') return node;
        try {
            return node.toString(indent);
        } catch (e) {
            return `-- [ERROR: ${e.message}]`;
        }
    }
}

/**
 * Container for sequential statements, handles block-level indentation.
 */
class Block extends Node {
    constructor(parent = null) {
        super();
        this.parent = parent;
        this.statements = [];
        this.endPos = 0; // Bytecode position where this block must close
    }

    add(stmt) {
        if (stmt) {
            stmt.parent = this;
            this.statements.push(stmt);
        }
    }

    toString(indent = "") {
        return this.statements.map(s => Node.safe(s, indent)).filter(s => s !== "").join("\n");
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

class VarReference extends Node { constructor(name) { super(); this.name = name; } toString() { return this.name; } }
class PropertyReference extends Node { constructor(name) { super(); this.name = name; } toString() { return this.name; } }
class LocalVarReference extends Node { constructor(name) { super(); this.name = name; } toString() { return this.name; } }
class ParamReference extends Node { constructor(name) { super(); this.name = name; } toString() { return this.name; } }

class Literal extends Node { constructor(value) { super(); this.value = value; } toString() { return String(this.value); } }
class IntLiteral extends Literal { }
class FloatLiteral extends Literal { }
class StringLiteral extends Literal { toString() { return `"${this.value}"`; } }
class SymbolLiteral extends Literal { toString() { return `#${this.value}`; } }

class ListLiteral extends Node {
    constructor(items = []) { super(); this.items = items; }
    toString() { return "[" + this.items.map(i => Node.safe(i)).join(", ") + "]"; }
}

class PropListLiteral extends Node {
    constructor(items = []) { super(); this.items = items; }
    toString() {
        if (this.items.length === 0) return "[:]";
        const res = [];
        for (let i = 0; i < this.items.length; i += 2) {
            res.push(`${Node.safe(this.items[i])}: ${Node.safe(this.items[i + 1])}`);
        }
        return "[" + res.join(", ") + "]";
    }
}

class ArgListLiteral extends Node {
    constructor(value = []) { super(); this.value = value; this.noRet = false; }
}

class AssignmentStatement extends Node {
    constructor(target, value) { super(); this.target = target; this.value = value; }
    toString(indent = "") {
        return `${indent}${Node.safe(this.target)} = ${Node.safe(this.value)}`;
    }
}

class CallStatement extends Node {
    constructor(name, args) { super(); this.name = name; this.args = args; }
    toString(indent = "") {
        const argStr = (this.args instanceof ArgListLiteral) ? this.args.value.map(v => Node.safe(v)).join(", ") : Node.safe(this.args);
        const needsParens = !LingoConfig.COMMANDS_WITHOUT_PARENS.includes(this.name);
        return `${indent}${this.name}${needsParens ? "(" : " "}${argStr}${needsParens ? ")" : ""}`;
    }
}

class ObjCallStatement extends Node {
    constructor(target, method, args) { super(); this.target = target; this.method = method; this.args = args; }
    toString(indent = "") {
        const argStr = (this.args instanceof ArgListLiteral) ? this.args.value.map(v => Node.safe(v)).join(", ") : Node.safe(this.args);
        return `${indent}${Node.safe(this.target)}.${this.method}(${argStr})`;
    }
}

class BinaryOperator extends Node {
    constructor(op, left, right) { super(); this.op = op; this.left = left; this.right = right; }
    toString() {
        let l = Node.safe(this.left);
        let r = Node.safe(this.right);
        const isAccess = (this.op === '.' || this.op === '[]');
        if (!isAccess) {
            if (this.left instanceof BinaryOperator && this.left.op !== '.' && this.left.op !== '[]') l = `(${l})`;
            if (this.right instanceof BinaryOperator && this.right.op !== '.' && this.right.op !== '[]') r = `(${r})`;
        }
        if (this.op === '.') return `${l}.${r}`;
        if (this.op === '[]') return `${l}[${r}]`;
        return `${l} ${this.op} ${r}`;
    }
}

class LogicalOperator extends Node {
    constructor(op, left, right) { super(); this.op = op; this.left = left; this.right = right; }
    toString() {
        let l = Node.safe(this.left);
        let r = Node.safe(this.right);
        if (this.left instanceof LogicalOperator) l = `(${l})`;
        if (this.right instanceof LogicalOperator) r = `(${r})`;
        return `${l} ${this.op} ${r}`;
    }
}

class NotOperator extends Node { constructor(expr) { super(); this.expr = expr; } toString() { return `not ${Node.safe(this.expr)}`; } }
class InverseOperator extends Node { constructor(expr) { super(); this.expr = expr; } toString() { return `-${Node.safe(this.expr)}`; } }

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
        let s = `${indent}if ${Node.safe(this.cond)} then\n`;
        s += this.block1.toString(indent + "  ");
        if (this.type === 1) {
            s += `\n${indent}else\n`;
            s += this.block2.toString(indent + "  ");
        }
        s += `\n${indent}end if`;
        return s;
    }
}

class CaseStatement extends Node {
    constructor(expr) { super(); this.expr = expr; this.branches = []; this.finalPos = -1; this.isOtherwiseActive = false; }
    addBranch(branch) { branch.parent = this; this.branches.push(branch); }
    toString(indent = "") {
        let s = `${indent}case ${Node.safe(this.expr)} of\n`;
        s += this.branches.map(b => b.toString(indent + "  ")).join("\n");
        s += `\n${indent}end case`;
        return s;
    }
}

class CaseBranch extends Node {
    constructor(labels = []) { super(); this.labels = labels; this.block = new Block(this); }
    toString(indent = "") {
        let s = indent + (this.labels.length === 0 ? "otherwise:" : this.labels.map(l => Node.safe(l)).join(", ") + ":") + "\n";
        s += this.block.toString(indent + "  ");
        return s;
    }
}

class RepeatWithStatement extends Node {
    constructor(it, start, end, down = false) { super(); this.it = it; this.start = start; this.end = end; this.down = down; this.block = new Block(this); }
    toString(indent = "") {
        let s = `${indent}repeat with ${this.it} = ${Node.safe(this.start)} ${this.down ? "down to" : "to"} ${Node.safe(this.end)}\n`;
        s += this.block.toString(indent + "  ");
        return s + `\n${indent}end repeat`;
    }
}

class RepeatWhileStatement extends Node {
    constructor(cond) { super(); this.cond = cond; this.block = new Block(this); }
    toString(indent = "") {
        return `${indent}repeat while ${Node.safe(this.cond)}\n${this.block.toString(indent + "  ")}\n${indent}end repeat`;
    }
}

class ReturnStatement extends Node {
    constructor(value) { super(); this.value = value; }
    toString(indent = "") {
        const val = Node.safe(this.value);
        return (val === "" || val === "-- [NULL]") ? `${indent}return` : `${indent}return ${val}`;
    }
}

class ExitStatement extends Node { toString(indent = "") { return `${indent}exit`; } }
class ERROR extends Node { constructor(msg) { super(); this.msg = msg; } toString() { return `-- [DECOMPILE ERROR: ${this.msg}]`; } }

/**
 * Main Translation State Machine
 * Converts Bytecode objects into AST Nodes within the given context.
 */
function translate(bc, ctx) {
    const { stack, ast, resolver } = ctx;
    const op = bc.opcode;

    const pop = () => stack.pop() || new ERROR("Stack Underflow");

    switch (op) {
        case 'ret':
            let rv = pop();
            if (rv instanceof ArgListLiteral) rv = (rv.value.length === 1) ? rv.value[0] : rv;
            if (rv?.toString() === '0' && ctx.index >= ctx.codes.length - 2 && ast.currentBlock.parent === ast.root) return;
            const last = ast.currentBlock.statements[ast.currentBlock.statements.length - 1];
            if (!(last instanceof ReturnStatement)) ast.addStatement(new ReturnStatement(rv));
            break;

        case 'ret_factory': ast.addStatement(new ExitStatement()); break;
        case 'pushint0': stack.push(new IntLiteral(0)); break;
        case 'pushint8': case 'pushint16': case 'pushint32': stack.push(new IntLiteral(bc.obj)); break;
        case 'pushfloat32': stack.push(new FloatLiteral(bc.obj)); break;
        case 'pushcons': stack.push(ctx.literals[bc.obj] || new IntLiteral(bc.obj)); break;
        case 'pushsymb': stack.push(new SymbolLiteral(resolver(bc.obj, "handle"))); break;
        case 'pushvarref': stack.push(new VarReference(resolver(bc.obj, "handle"))); break;
        case 'getlocal': stack.push(new LocalVarReference(ctx.handler.locals[bc.obj] || `l_${bc.obj}`)); break;
        case 'setlocal': ast.addStatement(new AssignmentStatement(new LocalVarReference(ctx.handler.locals[bc.obj] || `l_${bc.obj}`), pop())); break;
        case 'getparam': stack.push(new ParamReference(ctx.handler.args[bc.obj] || `a_${bc.obj}`)); break;
        case 'setparam': ast.addStatement(new AssignmentStatement(new ParamReference(ctx.handler.args[bc.obj] || `a_${bc.obj}`), pop())); break;
        case 'getprop': stack.push(new PropertyReference(resolver(bc.obj, "handle"))); break;
        case 'setprop':
            const pName = resolver(bc.obj, "handle");
            if (pName !== 'pNoiseStripped') ast.addStatement(new AssignmentStatement(new PropertyReference(pName), pop()));
            break;

        case 'getglobal': case 'getglobal2': stack.push(new VarReference(resolver(bc.obj, "global"))); break;
        case 'setglobal': case 'setglobal2': ast.addStatement(new AssignmentStatement(new VarReference(resolver(bc.obj, "global")), pop())); break;

        case 'getmovieprop': case 'gettoplevelprop': {
            const name = resolver(bc.obj, op.includes("movie") ? "movie" : "global");
            const path = ['_movie', '_player', '_system', 'mouseLoc'].includes(name) ? (op.includes("movie") ? '_movie.' : 'the ') + name : 'the ' + name;
            stack.push(new VarReference(path)); break;
        }

        case 'setmovieprop': {
            const name = resolver(bc.obj, "movie"), path = ['_player', '_system'].includes(name) ? '_movie.' + name : 'the ' + name;
            ast.addStatement(new AssignmentStatement(new VarReference(path), pop())); break;
        }

        case 'inv': stack.push(new InverseOperator(pop())); break;
        case 'not': stack.push(new NotOperator(pop())); break;
        case 'add': case 'sub': case 'mul': case 'div': case 'mod': case 'eq': case 'lt': case 'gt': case 'lteq': case 'gteq':
        case 'and': case 'or': case 'joinstr': case 'joinpadstr': case 'nteq': case 'containsstr': {
            const r = pop(), l = pop();
            const map = { add: '+', sub: '-', mul: '*', div: '/', mod: 'mod', eq: '=', lt: '<', gt: '>', lteq: '<=', gteq: '>=', and: 'and', or: 'or', joinstr: '&', joinpadstr: '&&', nteq: '<>', containsstr: 'contains' };
            stack.push(new BinaryOperator(map[op], l, r)); break;
        }

        case 'localcall': case 'extcall': case 'tellcall': {
            let fn, args = pop();
            if (op === 'localcall') {
                const target = ctx.handlers.find(h => h.hId === bc.obj);
                fn = target ? resolver(target.nameId, "handle") : `h_${bc.obj}`;
            } else fn = resolver(bc.obj, "handle");

            if (op === 'extcall' && bc.obj === LingoConfig.SPECIAL_IDS.EXT_CALL_MAGIC) {
                ast.addStatement(new ReturnStatement((args instanceof ArgListLiteral && args.value.length === 1) ? args.value[0] : args));
            } else if (['me', 'constant', 'return'].includes(fn)) {
                stack.push((args instanceof ArgListLiteral && args.value.length === 1) ? args.value[0] : args);
            } else if (fn === 'void') stack.push(new VarReference('VOID'));
            else {
                const call = new CallStatement(fn, args);
                if (args?.noRet) ast.addStatement(call); else stack.push(call);
            }
            break;
        }

        case 'pusharglist': case 'pusharglistnoret': {
            const arr = stack.splice(Math.max(0, stack.length - bc.obj), bc.obj);
            const list = new ArgListLiteral(arr);
            if (op.includes('noret')) list.noRet = true;
            stack.push(list); break;
        }

        case 'pop':
            const p = pop();
            if (p?.toString()?.includes('(')) ast.addStatement(p);
            break;

        case 'pushlist': stack.push(new ListLiteral(pop()?.value || [])); break;
        case 'pushproplist': stack.push(new PropListLiteral(pop()?.value || [])); break;

        case 'get': case 'set': {
            const invId = bc.obj & 0x3f;
            const ref = LingoConfig.V4_SPRITE_PROPS[invId] ? new VarReference('the ' + LingoConfig.V4_SPRITE_PROPS[invId]) : new VarReference(`v4_${invId}`);
            if (op === 'get') stack.push(ref); else ast.addStatement(new AssignmentStatement(ref, pop())); break;
        }

        case 'objcall': case 'objcallv4': {
            const oArgs = pop(), oVals = (oArgs instanceof ArgListLiteral) ? [...oArgs.value] : (oArgs ? [oArgs] : []);
            if (op === 'objcall' && oVals.length === 0) break;
            const oTarget = (op === 'objcall') ? oVals.shift() : new VarReference(resolver(bc.obj, "handle"));
            const oMethod = resolver(bc.obj, "handle");
            let node;
            if (oMethod === 'getProp' && oVals.length === 2) node = new BinaryOperator('.', oVals[0], new VarReference(String(oVals[1]).replace(/^#/, '')));
            else if (oMethod === 'getAt' && oVals.length === 1) node = new BinaryOperator('[]', oTarget, oVals[0]);
            else node = new ObjCallStatement(oTarget, oMethod, new ArgListLiteral(oVals));
            if (oArgs?.noRet) ast.addStatement(node); else stack.push(node);
            break;
        }

        case 'getobjprop': stack.push(new BinaryOperator('.', pop(), new VarReference(resolver(bc.obj, "handle")))); break;
        case 'setobjprop': {
            const val = pop(), tgt = pop();
            if (tgt) {
                const name = resolver(bc.obj, "handle");
                if (name === 'traceScript') ast.addStatement(new AssignmentStatement(new PropertyReference("the traceScript"), val));
                else ast.addStatement(new AssignmentStatement(new BinaryOperator('.', tgt, new VarReference(name)), val));
            }
            break;
        }

        case 'jmpifz': {
            const target = bc.pos + bc.len + bc.obj, cond = pop();
            if (ctx.activeCase && cond instanceof BinaryOperator && cond.op === '=') {
                const branch = new CaseBranch([cond.right]);
                branch.block.endPos = target;
                ctx.activeCase.addBranch(branch);
                ast.enterBlock(branch.block);
            } else {
                const si = new IfStatement(0, cond);
                si.block1.endPos = target;
                ast.addStatement(si);
                ast.enterBlock(si.block1);
            }
            break;
        }

        case 'jmp': {
            const target = bc.pos + bc.len + bc.obj, next = ctx.codes[ctx.index + 1];
            if (ast.currentBlock.parent instanceof IfStatement) {
                const si = ast.currentBlock.parent;
                if (next && (next.pos === si.block1.endPos)) {
                    si.setType(1);
                    si.block2.endPos = target;
                    si.block1.endPos = next.pos;
                }
            } else if (ast.currentBlock.parent instanceof CaseBranch) {
                const caseStmt = ast.currentBlock.parent.parent;
                if (caseStmt instanceof CaseStatement) caseStmt.finalPos = Math.max(caseStmt.finalPos, target);
            }
            break;
        }

        case 'peek':
            const peekVal = stack.peek();
            stack.push(peekVal);
            if (!ctx.activeCase && ctx.index + 3 < ctx.codes.length) {
                const n1 = ctx.codes[ctx.index + 1], n2 = ctx.codes[ctx.index + 2], n3 = ctx.codes[ctx.index + 3];
                if (n1.opcode === 'pushcons' && n2.opcode === 'eq' && n3.opcode === 'jmpifz') {
                    ctx.activeCase = new CaseStatement(peekVal);
                    ast.addStatement(ctx.activeCase);
                }
            }
            break;

        case 'newobj': {
            const nArgs = pop(), nVals = (nArgs instanceof ArgListLiteral) ? [...nArgs.value] : (nArgs ? [nArgs] : []);
            stack.push(new CallStatement('new', new ArgListLiteral([new VarReference(resolver(bc.obj, "handle")), ...nVals])));
            break;
        }
    }
}

module.exports = {
    translate, Node, Block, Handler, VarReference, PropertyReference, LocalVarReference, ParamReference,
    Literal, IntLiteral, FloatLiteral, StringLiteral, SymbolLiteral, ListLiteral, PropListLiteral,
    ArgListLiteral, AssignmentStatement, CallStatement, ObjCallStatement, BinaryOperator,
    LogicalOperator, NotOperator, InverseOperator, IfStatement, CaseStatement, CaseBranch,
    RepeatWithStatement, RepeatWhileStatement, ReturnStatement, ExitStatement, ERROR
};
