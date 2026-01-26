/**
 * @version 1.1.0
 * ASTWrapper.js - Orchestrator for hierarchical AST construction
 * 
 * Manages the "Active Block" stack during decompilation to ensure nested control 
 * flow structures (IF/REPEAT) are correctly nested in the final output.
 */

class ASTWrapper {
    /**
     * @param {object} rootHandler - The root Handler node for a script.
     */
    constructor(rootHandler) {
        this.root = rootHandler;
        this.blockStack = [rootHandler.block];
    }

    get currentBlock() {
        return this.blockStack[this.blockStack.length - 1];
    }

    /**
     * Adds a statement to the currently active scope.
     */
    addStatement(stmt) {
        this.currentBlock.add(stmt);
    }

    /**
     * Pushes a new block onto the scope stack.
     */
    enterBlock(block) {
        this.blockStack.push(block);
    }

    /**
     * Pops the current scope, returning to the parent block.
     */
    exitBlock() {
        if (this.blockStack.length > 1) this.blockStack.pop();
    }

    toString() {
        return this.root.toString();
    }
}

module.exports = ASTWrapper;
