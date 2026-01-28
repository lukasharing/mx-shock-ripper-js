/** @version 1.2.7
/**
 * ASTWrapper.js
 * 
 * ALGORITHM: Control Flow Block Tracking
 * -------------------------------------
 * This class facilitates the tree-building phase of the decompiler by 
 * tracking the "Active Block" during the sequential processing of bytecode.
 * 
 * 1. Root Handler: Initializes with the main Handler node of a script.
 * 2. Block Stack: Uses a stack to manage nested blocks (IF/ELSE, REPEAT).
 *    Processing jumps (like `jmpifz`) pushes a new block onto the stack.
 * 3. Scope Management: When the current bytecode position reaches the 
 *    `endPos` of the top-most block on the stack, that block is "exited" 
 *    (popped), returning the insertion point to the parent block.
 * 
 * Based on ProjectorRaysJS.
 */

const AST = require('./LingoAST');

class ASTWrapper {
    /**
     * @param {AST.Handler} handlerNode - The root handler AST node.
     */
    constructor(handlerNode) {
        this.root = handlerNode;
        this.currentBlock = handlerNode.block;
        this.blockStack = [this.currentBlock];
    }

    /**
     * Appends a statement to the currently active block.
     * @param {AST.Node} statement - The statement node (Assignment, Call, etc.).
     */
    addStatement(statement) {
        this.currentBlock.add(statement);
    }

    /**
     * Enters a new nested scope (e.g. the inside of an IF statement).
     * @param {AST.Block} block - The block being entered.
     */
    enterBlock(block) {
        this.blockStack.push(block);
        this.currentBlock = block;
    }

    /**
     * Exits the current scope and returns to the parent block.
     */
    exitBlock() {
        this.blockStack.pop();
        if (this.blockStack.length > 0) {
            this.currentBlock = this.blockStack[this.blockStack.length - 1];
        }
    }

    /**
     * Serializes the entire AST tree back to Lingo source code.
     */
    toString() {
        return this.root.toString();
    }
}

module.exports = ASTWrapper;
