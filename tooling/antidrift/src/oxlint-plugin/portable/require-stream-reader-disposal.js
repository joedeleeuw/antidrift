import {
  isRuleFile,
  scopeProperties,
} from "../../semantic-adapters/kernel/rule-scope.ts";
import { getPropertyName, isAstNode, isIdentifier } from "./ast.js";
import {
  breakExitsLoop,
  callWithinExpressionStatement,
  FUNCTION_TYPES,
  isDescendantOf,
  isInfiniteLoop,
  memberCall,
  nearestFunctionOrProgram,
  nearestLoopWithin,
  statementSite,
  staticMemberName,
  unwrapReaderExpression,
  visitNodes,
} from "./stream-reader-ast.js";
import {
  canPrecedeReaderCleanup,
  canWriteBinding,
} from "./stream-reader-cleanup.js";

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

    const acquisitions = [];
    const isEstreeIdentifier = (node) =>
      isIdentifier(node) && Array.isArray(node.range);
    const resolveVariable = (identifier) => {
      let scope = context.sourceCode.getScope(identifier);
      while (scope !== null) {
        const variable = scope.set.get(identifier.name);
        if (variable !== undefined) {
          return variable;
        }
        scope = scope.upper;
      }
      return null;
    };
    const canAssign = canWriteBinding.bind(null, resolveVariable);
    const isGlobalReference = (node, name) => {
      if (!isEstreeIdentifier(node) || node.name !== name) {
        return false;
      }
      const variable = resolveVariable(node);
      return variable === null || variable.defs.length === 0;
    };
    const namedType = (node, name) => {
      const typeNode = isAstNode(node) ? node : null;
      if (typeNode === null) {
        return false;
      }
      if (
        typeNode.type === "TSTypeAnnotation" ||
        typeNode.type === "TSParenthesizedType" ||
        typeNode.type === "TSOptionalType"
      ) {
        return namedType(typeNode.typeAnnotation, name);
      }
      if (typeNode.type === "TSUnionType" && Array.isArray(typeNode.types)) {
        const meaningfulTypes = typeNode.types.filter(
          (part) =>
            isAstNode(part) &&
            part.type !== "TSNullKeyword" &&
            part.type !== "TSUndefinedKeyword"
        );
        return (
          meaningfulTypes.length > 0 &&
          meaningfulTypes.every((part) => namedType(part, name))
        );
      }
      return (
        typeNode.type === "TSTypeReference" &&
        isIdentifier(typeNode.typeName, name) &&
        isGlobalReference(typeNode.typeName, name)
      );
    };
    const definitionName = (definition) => {
      if (isAstNode(definition.name)) {
        return definition.name;
      }
      if (
        isAstNode(definition.node) &&
        definition.node.type === "VariableDeclarator" &&
        isAstNode(definition.node.id)
      ) {
        return definition.node.id;
      }
      return null;
    };
    const variableHasType = (variable, name) =>
      variable.defs.some((definition) => {
        const identifier = definitionName(definition);
        return (
          identifier !== null && namedType(identifier.typeAnnotation, name)
        );
      });
    const constInitializer = (variable) => {
      for (const definition of variable.defs) {
        if (
          definition.type === "Variable" &&
          isAstNode(definition.node) &&
          definition.node.type === "VariableDeclarator" &&
          isAstNode(definition.parent) &&
          definition.parent.type === "VariableDeclaration" &&
          definition.parent.kind === "const"
        ) {
          return isAstNode(definition.node.init) ? definition.node.init : null;
        }
      }
      return null;
    };
    const responseBodyInitializer = (variable) => {
      for (const definition of variable.defs) {
        if (
          definition.type !== "Variable" ||
          !isAstNode(definition.node) ||
          definition.node.type !== "VariableDeclarator" ||
          !isAstNode(definition.parent) ||
          definition.parent.type !== "VariableDeclaration" ||
          definition.parent.kind !== "const" ||
          !isAstNode(definition.node.id) ||
          definition.node.id.type !== "ObjectPattern" ||
          !isAstNode(definition.node.init)
        ) {
          continue;
        }
        const properties = Array.isArray(definition.node.id.properties)
          ? definition.node.id.properties
          : [];
        for (const property of properties) {
          if (
            !isAstNode(property) ||
            property.type !== "Property" ||
            getPropertyName(property.key) !== "body"
          ) {
            continue;
          }
          let target = unwrapReaderExpression(property.value);
          if (target?.type === "AssignmentPattern") {
            target = unwrapReaderExpression(target.left);
          }
          if (
            isEstreeIdentifier(target) &&
            resolveVariable(target) === variable
          ) {
            return definition.node.init;
          }
        }
      }
      return null;
    };
    const isGlobalConstructor = (node, name) => {
      const expression = unwrapReaderExpression(node);
      if (expression?.type !== "NewExpression") {
        return false;
      }
      if (isGlobalReference(expression.callee, name)) {
        return true;
      }
      const callee = unwrapReaderExpression(expression.callee);
      if (
        callee?.type !== "MemberExpression" ||
        staticMemberName(callee) !== name
      ) {
        return false;
      }
      return ["globalThis", "self", "window"].some((host) =>
        isGlobalReference(callee.object, host)
      );
    };
    const isGlobalFetch = (node) => {
      const expression = unwrapReaderExpression(node);
      if (expression?.type !== "CallExpression") {
        return false;
      }
      if (isGlobalReference(expression.callee, "fetch")) {
        return true;
      }
      const callee = unwrapReaderExpression(expression.callee);
      if (
        callee?.type !== "MemberExpression" ||
        staticMemberName(callee) !== "fetch"
      ) {
        return false;
      }
      return ["globalThis", "self", "window"].some((host) =>
        isGlobalReference(callee.object, host)
      );
    };
    const isBunStdinStream = (node) => {
      const matched = memberCall(node, "stream");
      const stdin =
        matched === null ? null : unwrapReaderExpression(matched.object);
      return (
        matched !== null &&
        Array.isArray(matched.call.arguments) &&
        matched.call.arguments.length === 0 &&
        stdin?.type === "MemberExpression" &&
        staticMemberName(stdin) === "stdin" &&
        isGlobalReference(stdin.object, "Bun")
      );
    };
    const isResponseExpression = (node, visited = new Set()) => {
      const expression = unwrapReaderExpression(node);
      if (expression === null) {
        return false;
      }
      if (expression.type === "AwaitExpression") {
        return isGlobalFetch(expression.argument);
      }
      if (isGlobalConstructor(expression, "Response")) {
        return true;
      }
      if (!isEstreeIdentifier(expression)) {
        return false;
      }
      const variable = resolveVariable(expression);
      if (variable === null || visited.has(variable)) {
        return false;
      }
      if (variableHasType(variable, "Response")) {
        return true;
      }
      visited.add(variable);
      const initializer = constInitializer(variable);
      return initializer !== null && isResponseExpression(initializer, visited);
    };
    const isReadableStreamExpression = (node, visited = new Set()) => {
      const expression = unwrapReaderExpression(node);
      if (expression === null) {
        return false;
      }
      if (isGlobalConstructor(expression, "ReadableStream")) {
        return true;
      }
      if (isBunStdinStream(expression)) {
        return true;
      }
      if (expression.type === "MemberExpression") {
        return (
          staticMemberName(expression) === "body" &&
          isResponseExpression(expression.object)
        );
      }
      if (!isEstreeIdentifier(expression)) {
        return false;
      }
      const variable = resolveVariable(expression);
      if (variable === null || visited.has(variable)) {
        return false;
      }
      if (variableHasType(variable, "ReadableStream")) {
        return true;
      }
      const responseInitializer = responseBodyInitializer(variable);
      if (
        responseInitializer !== null &&
        isResponseExpression(responseInitializer)
      ) {
        return true;
      }
      visited.add(variable);
      const initializer = constInitializer(variable);
      return (
        initializer !== null && isReadableStreamExpression(initializer, visited)
      );
    };
    const canonicalBinding = (node, visited = new Set()) => {
      const expression = unwrapReaderExpression(node);
      if (!isEstreeIdentifier(expression)) {
        return null;
      }
      const variable = resolveVariable(expression);
      if (variable === null || visited.has(variable)) {
        return variable;
      }
      visited.add(variable);
      const initializer = constInitializer(variable);
      const aliased = canonicalBinding(initializer, visited);
      return aliased ?? variable;
    };
    const readerMethodCall = (node, method, binding) => {
      const matched = memberCall(node, method);
      return matched !== null && canonicalBinding(matched.object) === binding;
    };
    const containsReaderMethod = (node, method, binding) => {
      const root = unwrapReaderExpression(node);
      if (root === null) {
        return false;
      }
      let found = false;
      visitNodes(root, root, (candidate) => {
        if (readerMethodCall(candidate, method, binding)) {
          found = true;
        }
      });
      return found;
    };
    const acquisitionOwner = (node) => {
      let current = node;
      let parent = isAstNode(current.parent) ? current.parent : null;
      while (
        parent !== null &&
        (parent.type === "TSAsExpression" ||
          parent.type === "TSNonNullExpression" ||
          parent.type === "TSSatisfiesExpression" ||
          parent.type === "TSTypeAssertion")
      ) {
        current = parent;
        parent = isAstNode(current.parent) ? current.parent : null;
      }
      if (
        parent?.type === "VariableDeclarator" &&
        parent.init === current &&
        isEstreeIdentifier(parent.id)
      ) {
        const declaration = isAstNode(parent.parent) ? parent.parent : null;
        return {
          binding: resolveVariable(parent.id),
          stable:
            declaration?.type === "VariableDeclaration" &&
            declaration.kind === "const",
        };
      }
      if (
        parent?.type === "AssignmentExpression" &&
        parent.right === current &&
        isEstreeIdentifier(parent.left)
      ) {
        return { binding: resolveVariable(parent.left), stable: false };
      }
      return { binding: null, stable: false };
    };
    const directlyReturned = (node) => {
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
    const methodStatementIndexes = (block, method, binding) => {
      if (
        !isAstNode(block) ||
        block.type !== "BlockStatement" ||
        !Array.isArray(block.body)
      ) {
        return [];
      }
      const indexes = [];
      for (const [index, statement] of block.body.entries()) {
        if (
          callWithinExpressionStatement(
            statement,
            (candidate) => readerMethodCall(candidate, method, binding),
            canAssign
          )
        ) {
          indexes.push(index);
        }
      }
      return indexes;
    };
    const handledCancelStatement = (statement, binding) => {
      if (!isAstNode(statement) || statement.type !== "ExpressionStatement") {
        return false;
      }
      let expression = unwrapReaderExpression(statement.expression);
      while (
        expression?.type === "AwaitExpression" ||
        (expression?.type === "AssignmentExpression" &&
          expression.operator === "=" &&
          isIdentifier(expression.left) &&
          canAssign(expression.left))
      ) {
        const innerExpression =
          expression.type === "AwaitExpression"
            ? expression.argument
            : expression.right;
        expression = unwrapReaderExpression(innerExpression);
      }
      if (expression?.type !== "CallExpression") {
        return false;
      }
      const callee = unwrapReaderExpression(expression.callee);
      return (
        callee?.type === "MemberExpression" &&
        staticMemberName(callee) === "catch" &&
        readerMethodCall(callee.object, "cancel", binding) !== null
      );
    };
    const finalizerCleanup = (block, binding) => {
      if (
        !isAstNode(block) ||
        block.type !== "BlockStatement" ||
        !Array.isArray(block.body)
      ) {
        return { cancelBeforeRelease: false, releases: false };
      }
      let handledCancel = false;
      for (const statement of block.body) {
        if (
          callWithinExpressionStatement(
            statement,
            (candidate) => readerMethodCall(candidate, "releaseLock", binding),
            canAssign
          )
        ) {
          return {
            cancelBeforeRelease: handledCancel,
            releases: true,
          };
        }
        if (
          callWithinExpressionStatement(
            statement,
            (candidate) => readerMethodCall(candidate, "cancel", binding),
            canAssign
          )
        ) {
          if (!handledCancelStatement(statement, binding)) {
            return { cancelBeforeRelease: false, releases: false };
          }
          handledCancel = true;
          continue;
        }
        if (
          isAstNode(statement) &&
          statement.type === "TryStatement" &&
          isAstNode(statement.finalizer)
        ) {
          const nested = finalizerCleanup(statement.finalizer, binding);
          if (nested.releases) {
            const tryCancels =
              methodStatementIndexes(statement.block, "cancel", binding)
                .length > 0;
            return {
              cancelBeforeRelease:
                handledCancel || tryCancels || nested.cancelBeforeRelease,
              releases: true,
            };
          }
        }
        return { cancelBeforeRelease: false, releases: false };
      }
      return { cancelBeforeRelease: false, releases: false };
    };
    const tryCoversAcquisition = (tryNode, acquisition) => {
      if (isDescendantOf(acquisition.node, tryNode.block)) {
        return true;
      }
      const acquisitionSite = statementSite(acquisition.node);
      const trySite = statementSite(tryNode);
      if (
        acquisitionSite === null ||
        trySite === null ||
        acquisitionSite.block !== trySite.block ||
        !Array.isArray(acquisitionSite.block.body)
      ) {
        return false;
      }
      const acquisitionIndex = acquisitionSite.block.body.indexOf(
        acquisitionSite.statement
      );
      const tryIndex = acquisitionSite.block.body.indexOf(trySite.statement);
      return (
        acquisitionIndex !== -1 &&
        tryIndex > acquisitionIndex &&
        canPrecedeReaderCleanup(
          acquisitionSite.block.body.slice(acquisitionIndex + 1, tryIndex),
          {
            resolveVariable,
          }
        )
      );
    };
    const protectingTry = (acquisition, binding) => {
      let result = null;
      visitNodes(acquisition.root, acquisition.root, (node) => {
        if (
          result !== null ||
          node.type !== "TryStatement" ||
          !isAstNode(node.finalizer) ||
          !tryCoversAcquisition(node, acquisition) ||
          !finalizerCleanup(node.finalizer, binding).releases
        ) {
          return;
        }
        result = node;
      });
      return result;
    };
    const hasTransferredBinding = (acquisition, binding) => {
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
        canonicalBinding(finalStatement.argument) !== binding
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
            resolveVariable,
          }
        )
      ) {
        return false;
      }
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
            readerMethodCall(node, method, binding)
          )
        ) {
          used = true;
        }
      });
      return !hasCompetingExit && !used;
    };
    const readResultKind = (identifier, binding) => {
      const variable = resolveVariable(identifier);
      if (variable === null) {
        return null;
      }
      if (
        variable.references.some(
          (reference) =>
            reference.init !== true && reference.isWrite?.() === true
        )
      ) {
        return null;
      }
      for (const definition of variable.defs) {
        if (
          definition.type !== "Variable" ||
          !isAstNode(definition.node) ||
          definition.node.type !== "VariableDeclarator" ||
          !isAstNode(definition.parent) ||
          definition.parent.type !== "VariableDeclaration" ||
          definition.parent.kind !== "const"
        ) {
          continue;
        }
        let initializer = unwrapReaderExpression(definition.node.init);
        if (initializer?.type === "AwaitExpression") {
          initializer = unwrapReaderExpression(initializer.argument);
        }
        if (!readerMethodCall(initializer, "read", binding)) {
          continue;
        }
        if (isIdentifier(definition.node.id, identifier.name)) {
          return "result";
        }
        if (
          isAstNode(definition.node.id) &&
          definition.node.id.type === "ObjectPattern" &&
          Array.isArray(definition.node.id.properties) &&
          definition.node.id.properties.some(
            (property) =>
              isAstNode(property) &&
              property.type === "Property" &&
              getPropertyName(property.key) === "done" &&
              isIdentifier(property.value, identifier.name)
          )
        ) {
          return "done";
        }
      }
      return null;
    };
    const isDoneGuard = (node, binding) => {
      const expression = unwrapReaderExpression(node);
      if (isEstreeIdentifier(expression)) {
        return readResultKind(expression, binding) === "done";
      }
      if (
        expression?.type === "MemberExpression" &&
        staticMemberName(expression) === "done" &&
        isEstreeIdentifier(unwrapReaderExpression(expression.object))
      ) {
        const object = unwrapReaderExpression(expression.object);
        return (
          isEstreeIdentifier(object) &&
          readResultKind(object, binding) === "result"
        );
      }
      if (
        expression?.type === "BinaryExpression" &&
        (expression.operator === "===" || expression.operator === "==")
      ) {
        return (
          (isDoneGuard(expression.left, binding) &&
            isLiteralTrue(expression.right)) ||
          (isLiteralTrue(expression.left) &&
            isDoneGuard(expression.right, binding))
        );
      }
      return false;
    };
    const dominatedByDoneGuard = (node, binding) => {
      let child = node;
      let parent = isAstNode(child.parent) ? child.parent : null;
      while (parent !== null && !FUNCTION_TYPES.has(parent.type)) {
        if (
          parent.type === "IfStatement" &&
          parent.consequent === child &&
          isDoneGuard(parent.test, binding)
        ) {
          return true;
        }
        child = parent;
        parent = isAstNode(child.parent) ? child.parent : null;
      }
      return false;
    };
    const hasPriorCancel = (node, binding) => {
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
            (candidate) => readerMethodCall(candidate, "cancel", binding),
            canAssign
          )
        );
    };
    const catchCancels = (tryNode, binding) => {
      if (!isAstNode(tryNode.handler) || !isAstNode(tryNode.handler.body)) {
        return false;
      }
      const cancelIndex = methodStatementIndexes(
        tryNode.handler.body,
        "cancel",
        binding
      ).at(0);
      const safePrefix =
        cancelIndex !== undefined &&
        canPrecedeReaderCleanup(
          tryNode.handler.body.body.slice(0, cancelIndex),
          {
            resolveVariable,
            allowAssignments: true,
          }
        );
      return safePrefix;
    };
    const trailingCancelCoversTopLevelReads = (tryNode, binding) => {
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
        if (!readerMethodCall(node, "read", binding)) {
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
      return methodStatementIndexes(block, "cancel", binding).some(
        (index) => index === lastReadIndex + 1
      );
    };
    const readPathsRequireFinalCancel = (tryNode, binding) => {
      const block = isAstNode(tryNode.block) ? tryNode.block : null;
      if (block === null) {
        return true;
      }
      const readCalls = [];
      visitNodes(block, block, (node) => {
        if (readerMethodCall(node, "read", binding)) {
          readCalls.push(node);
        }
      });
      if (readCalls.length === 0) {
        return false;
      }
      if (
        readCalls.length === 1 &&
        trailingCancelCoversTopLevelReads(tryNode, binding)
      ) {
        return false;
      }
      const handlerCancels = catchCancels(tryNode, binding);
      const readLoops = new Set();
      for (const readCall of readCalls) {
        const loop = nearestLoopWithin(readCall, block);
        if (loop === null || !isInfiniteLoop(loop)) {
          return true;
        }
        readLoops.add(loop);
      }
      for (const loop of readLoops) {
        let unsafeExit = false;
        visitNodes(loop, loop, (node) => {
          if (unsafeExit) {
            return;
          }
          if (node.type === "ThrowStatement") {
            unsafeExit = !handlerCancels && !hasPriorCancel(node, binding);
            return;
          }
          if (node.type === "YieldExpression") {
            unsafeExit = true;
            return;
          }
          if (node.type === "AwaitExpression") {
            const awaited = unwrapReaderExpression(node.argument);
            if (
              !dominatedByDoneGuard(node, binding) &&
              !containsReaderMethod(awaited, "read", binding) &&
              !containsReaderMethod(awaited, "cancel", binding)
            ) {
              unsafeExit = !handlerCancels && !hasPriorCancel(node, binding);
            }
            return;
          }
          if (node.type === "ReturnStatement") {
            unsafeExit =
              !dominatedByDoneGuard(node, binding) &&
              !hasPriorCancel(node, binding);
            return;
          }
          if (node.type === "BreakStatement" && breakExitsLoop(node, loop)) {
            unsafeExit =
              !dominatedByDoneGuard(node, binding) &&
              !hasPriorCancel(node, binding);
          }
        });
        if (unsafeExit) {
          return true;
        }
      }
      return false;
    };
    if (
      (() => {
        acquisitions.length = 0;
        return context.sourceCode.text.includes("getReader");
      })() === false
    ) {
      return {};
    }
    return {
      CallExpression(node) {
        const matched = memberCall(node, "getReader");
        if (matched === null || !isReadableStreamExpression(matched.object)) {
          return;
        }
        const root = nearestFunctionOrProgram(node);
        if (root === null) {
          return;
        }
        const owner = acquisitionOwner(matched.call);
        acquisitions.push({
          binding: owner.binding,
          node,
          root,
          stableOwner: owner.stable,
        });
      },
      "Program:exit"() {
        for (const acquisition of acquisitions) {
          if (directlyReturned(acquisition.node)) {
            continue;
          }
          const binding = acquisition.binding;
          if (
            binding !== null &&
            acquisition.stableOwner &&
            hasTransferredBinding(acquisition, binding)
          ) {
            continue;
          }
          if (binding === null) {
            context.report({
              node: acquisition.node,
              messageId: "releaseInFinally",
            });
            continue;
          }
          const tryNode = protectingTry(acquisition, binding);
          if (tryNode === null) {
            context.report({
              node: acquisition.node,
              messageId: "releaseInFinally",
            });
            continue;
          }
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
            context.report({
              node: acquisition.node,
              messageId: "releaseInFinally",
            });
            continue;
          }
          const cleanup = finalizerCleanup(tryNode.finalizer, binding);
          if (
            !cleanup.cancelBeforeRelease &&
            readPathsRequireFinalCancel(tryNode, binding)
          ) {
            context.report({
              node: acquisition.node,
              messageId: "cancelBeforeRelease",
            });
          }
        }
      },
    };
  },
};
