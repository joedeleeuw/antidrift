import { isRuleFile, scopeProperties } from "../shared/rule-scope.js";
import { isAstNode } from "./ast.js";
import {
  breakExitsLoop,
  callWithinExpressionStatement,
  FUNCTION_TYPES,
  isInfiniteLoop,
  memberCall,
  nearestFunctionOrProgram,
  nearestLoopWithin,
  statementSite,
  unwrapReaderExpression,
  visitNodes,
} from "./stream-reader-ast.js";
import {
  canPrecedeReaderCleanup,
  ReaderCleanup,
} from "./stream-reader-cleanup.js";
import { StreamReaderState } from "./stream-reader-state.js";

class ReaderDisposalAnalysis {
  constructor(context) {
    this.context = context;
    this.acquisitions = [];
    this.reader = new StreamReaderState(context.sourceCode);
    this.cleanup = new ReaderCleanup(this.reader);
  }
  directlyReturned = (node) => {
    const expression = unwrapReaderExpression(node);
    if (expression === null) {
      return false;
    }
    let current = expression;
    let parent = isAstNode(current.parent) ? current.parent : null;
    while (
      parent !== null &&
      (parent.type === "TSAsExpression" ||
        parent.type === "TSNonNullExpression" ||
        parent.type === "TSSatisfiesExpression" ||
        parent.type === "TSTypeAssertion" ||
        parent.type === "AwaitExpression")
    ) {
      current = parent;
      parent = isAstNode(current.parent) ? current.parent : null;
    }
    return (
      (parent?.type === "ReturnStatement" && parent.argument === current) ||
      (parent?.type === "ArrowFunctionExpression" && parent.body === current)
    );
  };

  protectingTry = (acquisition, binding) => {
    let protectingStatement = null;
    visitNodes(acquisition.root, acquisition.root, (node) => {
      if (
        protectingStatement !== null ||
        node.type !== "TryStatement" ||
        !isAstNode(node.finalizer) ||
        !this.cleanup.tryCoversAcquisition(node, acquisition) ||
        !this.cleanup.finalizerCleanup(node.finalizer, binding).releases
      ) {
        return;
      }
      protectingStatement = node;
    });
    return protectingStatement;
  };

  hasTransferredBinding = (acquisition, binding) => {
    const body = acquisition.root.body;
    if (
      !isAstNode(body) ||
      body.type !== "BlockStatement" ||
      !Array.isArray(body.body)
    ) {
      return false;
    }
    const finalStatement = body.body.at(-1);
    if (
      !isAstNode(finalStatement) ||
      finalStatement.type !== "ReturnStatement" ||
      this.reader.canonicalBinding(finalStatement.argument) !== binding
    ) {
      return false;
    }
    const acquisitionSite = statementSite(acquisition.node);
    if (
      acquisitionSite === null ||
      acquisitionSite.block !== body ||
      !Array.isArray(body.body)
    ) {
      return false;
    }
    const acquisitionIndex = body.body.indexOf(acquisitionSite.statement);
    const returnIndex = body.body.indexOf(finalStatement);
    if (
      acquisitionIndex === -1 ||
      returnIndex === -1 ||
      !canPrecedeReaderCleanup(
        body.body.slice(acquisitionIndex + 1, returnIndex),
        {
          resolveVariable: this.reader.resolveVariable,
        }
      )
    ) {
      return false;
    }
    return this.transferHasNoCompetingUse(acquisition, binding, finalStatement);
  };

  transferHasNoCompetingUse = (acquisition, binding, finalStatement) => {
    let used = false;
    let hasCompetingExit = false;
    visitNodes(acquisition.root, acquisition.root, (node) => {
      if (
        (node.type === "ReturnStatement" && node !== finalStatement) ||
        node.type === "ThrowStatement"
      ) {
        hasCompetingExit = true;
      }
      if (
        node.type === "CallExpression" &&
        ["cancel", "read", "releaseLock"].some((method) =>
          this.reader.readerMethodCall(node, method, binding)
        )
      ) {
        used = true;
      }
    });
    return !hasCompetingExit && !used;
  };

  dominatedByDoneGuard = (node, binding) => {
    let child = node;
    let parent = isAstNode(child.parent) ? child.parent : null;
    while (parent !== null && !FUNCTION_TYPES.has(parent.type)) {
      if (
        parent.type === "IfStatement" &&
        parent.consequent === child &&
        this.reader.isDoneGuard(parent.test, binding)
      ) {
        return true;
      }
      child = parent;
      parent = isAstNode(child.parent) ? child.parent : null;
    }
    return false;
  };

  hasPriorCancel = (node, binding) => {
    const site = statementSite(node);
    if (site === null || !Array.isArray(site.block.body)) {
      return false;
    }
    const index = site.block.body.indexOf(site.statement);
    return site.block.body
      .slice(0, index)
      .some((statement) =>
        callWithinExpressionStatement(
          statement,
          (candidate) =>
            this.reader.readerMethodCall(candidate, "cancel", binding),
          this.reader.canAssign
        )
      );
  };

  catchCancels = (tryNode, binding) => {
    if (!isAstNode(tryNode.handler) || !isAstNode(tryNode.handler.body)) {
      return false;
    }
    const cancelIndex = this.cleanup
      .methodStatementIndexes(tryNode.handler.body, "cancel", binding)
      .at(0);
    const safePrefix =
      cancelIndex !== undefined &&
      canPrecedeReaderCleanup(tryNode.handler.body.body.slice(0, cancelIndex), {
        resolveVariable: this.reader.resolveVariable,
        allowAssignments: true,
      });
    return safePrefix;
  };

  trailingCancelCoversTopLevelReads = (tryNode, binding) => {
    if (
      !isAstNode(tryNode.block) ||
      tryNode.block.type !== "BlockStatement" ||
      !Array.isArray(tryNode.block.body)
    ) {
      return false;
    }
    const block = tryNode.block;
    const body = tryNode.block.body;
    const readStatementIndexes = [];
    let hasNestedRead = false;
    visitNodes(block, block, (node) => {
      if (!this.reader.readerMethodCall(node, "read", binding)) {
        return;
      }
      const site = statementSite(node);
      if (site === null || site.block !== block) {
        hasNestedRead = true;
        return;
      }
      const index = body.indexOf(site.statement);
      if (index !== -1) {
        readStatementIndexes.push(index);
      }
    });
    if (hasNestedRead || readStatementIndexes.length === 0) {
      return false;
    }
    const lastReadIndex = Math.max(...readStatementIndexes);
    return this.cleanup
      .methodStatementIndexes(block, "cancel", binding)
      .some((index) => index === lastReadIndex + 1);
  };

  readPathsRequireFinalCancel = (tryNode, binding) => {
    const block = isAstNode(tryNode.block) ? tryNode.block : null;
    if (block === null) {
      return true;
    }
    const readCalls = [];
    visitNodes(block, block, (node) => {
      if (this.reader.readerMethodCall(node, "read", binding)) {
        readCalls.push(node);
      }
    });
    if (readCalls.length === 0) {
      return false;
    }
    if (
      readCalls.length === 1 &&
      this.trailingCancelCoversTopLevelReads(tryNode, binding)
    ) {
      return false;
    }
    const handlerCancels = this.catchCancels(tryNode, binding);
    const readLoops = new Set();
    for (const readCall of readCalls) {
      const loop = nearestLoopWithin(readCall, block);
      if (loop === null || !isInfiniteLoop(loop)) {
        return true;
      }
      readLoops.add(loop);
    }
    for (const loop of readLoops) {
      const unsafeExit = this.loopHasUnsafeExit(loop, binding, handlerCancels);
      if (unsafeExit) {
        return true;
      }
    }
    return false;
  };

  loopHasUnsafeExit = (loop, binding, handlerCancels) => {
    let unsafeExit = false;
    visitNodes(loop, loop, (node) => {
      if (unsafeExit) {
        return;
      }
      if (node.type === "ThrowStatement") {
        unsafeExit = !handlerCancels && !this.hasPriorCancel(node, binding);
        return;
      }
      if (node.type === "YieldExpression") {
        unsafeExit = true;
        return;
      }
      if (node.type === "AwaitExpression") {
        const awaited = unwrapReaderExpression(node.argument);
        if (
          !this.dominatedByDoneGuard(node, binding) &&
          !this.reader.containsReaderMethod(awaited, "read", binding) &&
          !this.reader.containsReaderMethod(awaited, "cancel", binding)
        ) {
          unsafeExit = !handlerCancels && !this.hasPriorCancel(node, binding);
        }
        return;
      }
      if (node.type === "ReturnStatement") {
        unsafeExit =
          !this.dominatedByDoneGuard(node, binding) &&
          !this.hasPriorCancel(node, binding);
        return;
      }
      if (node.type === "BreakStatement" && breakExitsLoop(node, loop)) {
        unsafeExit =
          !this.dominatedByDoneGuard(node, binding) &&
          !this.hasPriorCancel(node, binding);
      }
    });
    return unsafeExit;
  };

  onCallExpression = (node) => {
    const matched = memberCall(node, "getReader");
    if (
      matched === null ||
      !this.reader.isReadableStreamExpression(matched.object)
    ) {
      return;
    }
    const root = nearestFunctionOrProgram(node);
    if (root === null) {
      return;
    }
    const owner = this.reader.acquisitionOwner(matched.call);
    this.acquisitions.push({
      binding: owner.binding,
      node,
      root,
      stableOwner: owner.stable,
    });
  };

  acquisitionProblem = (acquisition) => {
    if (this.directlyReturned(acquisition.node)) return null;
    const binding = acquisition.binding;
    if (
      binding !== null &&
      acquisition.stableOwner &&
      this.hasTransferredBinding(acquisition, binding)
    ) {
      return null;
    }
    if (binding === null) return "releaseInFinally";
    const tryNode = this.protectingTry(acquisition, binding);
    if (tryNode === null) return "releaseInFinally";
    const releaseEnd =
      tryNode.finalizer.body[0]?.range?.[1] ?? tryNode.finalizer.range[1];
    if (
      binding.references.some(
        (reference) =>
          reference.isWrite() &&
          reference.identifier.range[0] > acquisition.node.range[1] &&
          reference.identifier.range[0] < releaseEnd
      )
    ) {
      return "releaseInFinally";
    }
    const cleanup = this.cleanup.finalizerCleanup(tryNode.finalizer, binding);
    return !cleanup.cancelBeforeRelease &&
      this.readPathsRequireFinalCancel(tryNode, binding)
      ? "cancelBeforeRelease"
      : null;
  };

  onProgramExit = () => {
    for (const acquisition of this.acquisitions) {
      const messageId = this.acquisitionProblem(acquisition);
      if (messageId !== null) {
        this.context.report({ node: acquisition.node, messageId });
      }
    }
  };

  listeners() {
    return {
      CallExpression: this.onCallExpression,
      "Program:exit": this.onProgramExit,
    };
  }
}

export default {
  meta: {
    schema: [
      {
        type: "object",
        properties: scopeProperties,
        additionalProperties: false,
      },
    ],

    type: "problem",
    messages: {
      cancelBeforeRelease:
        "This ReadableStream reader can stop before EOF. Cancel it before releasing its lock so the producer is not left active.",
      releaseInFinally:
        "Release this ReadableStream reader's lock in a finally block, or explicitly return the reader to transfer ownership.",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    if (!context.sourceCode.text.includes("getReader")) return {};
    return new ReaderDisposalAnalysis(context).listeners();
  },
};
