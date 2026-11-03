import {
  constInitializer,
  findVariable,
  isFunctionLike,
  unwrapExpression,
} from "../shared/scope.js";

const COMPARISON_OPERATORS = new Set([
  "===",
  "!==",
  "==",
  "!=",
  "<",
  "<=",
  ">",
  ">=",
  "in",
  "instanceof",
]);

const BOOLEAN_METHOD_NAMES = new Set([
  "every",
  "existsSync",
  "endsWith",
  "equals",
  "has",
  "hasOwn",
  "includes",
  "isArray",
  "isFinite",
  "isInteger",
  "isNaN",
  "isSafeInteger",
  "isRead",
  "isWrite",
  "matches",
  "matchesGlob",
  "some",
  "startsWith",
  "test",
]);

const BOOLEAN_CALL_PREFIX_RE =
  /^(?:is|has|can|should|matches|includes|contains|startsWith|endsWith|check|test|allows|supports|needs|requires|uses|returns|owns|accepts|declares|exposes|verify|validate)[A-Z_]/u;

const BOOLEAN_PROP_RE =
  /^(?:is[A-Z_]|has[A-Z_]|can[A-Z_]|should[A-Z_]|optional$|computed$|async$|generator$|static$|done$|ok$|valid$|disabled$|checked$|selected$|hidden$|open$|loading$|archived$|pinned$)/u;

const ARRAY_PREDICATE_METHODS = new Set([
  "every",
  "filter",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "some",
]);

const COALESCE_HELPER_RE =
  /^(?:coalesce|firstDefined|firstNonNull|firstNonNullish|firstNonEmpty|firstTruthy|pickFirst)$/iu;

function functionReturnsBooleanLiteral(fnNode) {
  if (!fnNode || !isFunctionLike(fnNode)) return false;
  const retAnn = fnNode.returnType?.typeAnnotation;
  if (
    retAnn?.type === "TSBooleanKeyword" ||
    retAnn?.type === "TSTypePredicate"
  ) {
    return true;
  }
  if (fnNode.body?.type !== "BlockStatement") return false;
  return (fnNode.body.body ?? []).some(
    (stmt) =>
      stmt.type === "ReturnStatement" &&
      stmt.argument?.type === "Literal" &&
      typeof stmt.argument.value === "boolean"
  );
}

function isBooleanCall(expr, sourceCode) {
  if (expr?.type !== "CallExpression") return false;
  const callee = unwrapExpression(expr.callee);
  if (callee?.type === "Identifier") {
    if (
      callee.name === "Boolean" ||
      BOOLEAN_METHOD_NAMES.has(callee.name) ||
      BOOLEAN_CALL_PREFIX_RE.test(callee.name)
    ) {
      return true;
    }
    const def = findVariable(sourceCode, callee)?.defs?.[0];
    return functionReturnsBooleanLiteral(def?.node);
  }
  if (
    callee?.type === "MemberExpression" &&
    !callee.computed &&
    callee.property?.type === "Identifier"
  ) {
    const propName = callee.property.name;
    return (
      BOOLEAN_METHOD_NAMES.has(propName) ||
      BOOLEAN_CALL_PREFIX_RE.test(propName)
    );
  }
  return false;
}

function isSyntacticBooleanOperand(node, sourceCode, depth = 0) {
  if (depth > 3) return false;
  const expr = unwrapExpression(node);
  if (!expr) return false;
  if (expr.type === "Literal" && typeof expr.value === "boolean") return true;
  if (expr.type === "UnaryExpression" && expr.operator === "!") return true;
  if (
    expr.type === "BinaryExpression" &&
    COMPARISON_OPERATORS.has(expr.operator)
  ) {
    return true;
  }
  if (expr.type === "LogicalExpression" && expr.operator === "&&") {
    return (
      isSyntacticBooleanOperand(expr.left, sourceCode, depth + 1) ||
      isSyntacticBooleanOperand(expr.right, sourceCode, depth + 1)
    );
  }
  if (isBooleanCall(expr, sourceCode)) return true;
  if (
    expr.type === "MemberExpression" &&
    !expr.computed &&
    expr.property?.type === "Identifier"
  ) {
    return BOOLEAN_PROP_RE.test(expr.property.name);
  }
  if (expr.type === "Identifier") {
    if (BOOLEAN_PROP_RE.test(expr.name)) return true;
    const init = constInitializer(sourceCode, expr);
    return init
      ? isSyntacticBooleanOperand(init, sourceCode, depth + 1)
      : false;
  }
  return false;
}

function enclosingFunctionIsBooleanPredicate(node) {
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (!isFunctionLike(cur)) continue;
    if (functionReturnsBooleanLiteral(cur)) return true;
    const fnName =
      cur.id?.name ??
      (cur.parent?.type === "VariableDeclarator" &&
      cur.parent.id?.type === "Identifier"
        ? cur.parent.id.name
        : "");
    if (BOOLEAN_CALL_PREFIX_RE.test(fnName)) return true;
    const callParent = cur.parent;
    return (
      callParent?.type === "CallExpression" &&
      callParent.arguments.includes(cur) &&
      callParent.callee?.type === "MemberExpression" &&
      !callParent.callee.computed &&
      ARRAY_PREDICATE_METHODS.has(callParent.callee.property?.name)
    );
  }
  return false;
}

function isInBooleanSink(node) {
  let cur = node;
  while (cur?.parent) {
    const parent = cur.parent;
    if (
      parent.type === "ParenthesizedExpression" ||
      (parent.type === "LogicalExpression" &&
        (parent.operator === "||" || parent.operator === "&&"))
    ) {
      cur = parent;
      continue;
    }
    if (
      ((parent.type === "IfStatement" ||
        parent.type === "WhileStatement" ||
        parent.type === "DoWhileStatement" ||
        parent.type === "ForStatement" ||
        parent.type === "ConditionalExpression") &&
        parent.test === cur) ||
      (parent.type === "UnaryExpression" && parent.operator === "!") ||
      (parent.type === "CallExpression" &&
        parent.callee?.type === "Identifier" &&
        parent.callee.name === "Boolean")
    ) {
      return true;
    }
    if (
      parent.type === "ReturnStatement" ||
      (isFunctionLike(parent) && parent.body === cur)
    ) {
      return enclosingFunctionIsBooleanPredicate(cur);
    }
    return false;
  }
  return false;
}

function collectCoalesceChain(node, operators = [], leaves = []) {
  const expr = unwrapExpression(node);
  if (
    expr?.type === "LogicalExpression" &&
    (expr.operator === "??" || expr.operator === "||")
  ) {
    operators.push(expr.operator);
    collectCoalesceChain(expr.left, operators, leaves);
    collectCoalesceChain(expr.right, operators, leaves);
    return { operators, leaves };
  }
  leaves.push(expr);
  return { operators, leaves };
}

function isPureBooleanDisjunction(node, sourceCode) {
  const { operators, leaves } = collectCoalesceChain(node);
  if (operators.length === 0 || operators.includes("??")) return false;
  if (isInBooleanSink(node)) return true;
  return leaves.some((leaf) => isSyntacticBooleanOperand(leaf, sourceCode));
}

function isNullishNode(node) {
  const expr = unwrapExpression(node);
  return (
    (expr?.type === "Literal" && expr.value === null) ||
    (expr?.type === "Identifier" && expr.name === "undefined")
  );
}

function isAbsenceLiteralOrNullish(node) {
  return isNullishNode(node) || (node?.type === "Literal" && node.value === "");
}

function extractTestedPresenceCandidate(testNode, sourceCode) {
  const test = unwrapExpression(testNode);
  if (!test) return null;
  if (test.type === "Identifier" || test.type === "MemberExpression") {
    return {
      candidateText: sourceCode.getText(test).replace(/\s+/gu, ""),
      inverted: false,
    };
  }
  if (test.type === "UnaryExpression" && test.operator === "!") {
    const inner = extractTestedPresenceCandidate(test.argument, sourceCode);
    return inner ? { ...inner, inverted: !inner.inverted } : null;
  }
  if (
    test.type === "CallExpression" &&
    test.callee?.type === "Identifier" &&
    test.callee.name === "Boolean" &&
    test.arguments.length === 1
  ) {
    return extractTestedPresenceCandidate(test.arguments[0], sourceCode);
  }
  if (test.type !== "BinaryExpression") return null;
  const { operator, left, right } = test;
  if (
    (operator === "!==" ||
      operator === "!=" ||
      operator === "===" ||
      operator === "==") &&
    isAbsenceLiteralOrNullish(right)
  ) {
    return {
      candidateText: sourceCode.getText(left).replace(/\s+/gu, ""),
      inverted: operator === "===" || operator === "==",
    };
  }
  return null;
}

function extractValueFallbackTernary(node, sourceCode) {
  const expr = unwrapExpression(node);
  if (expr?.type !== "ConditionalExpression") return null;
  const tested = extractTestedPresenceCandidate(expr.test, sourceCode);
  if (!tested) return null;
  const presentBranch = tested.inverted ? expr.alternate : expr.consequent;
  const fallbackBranch = tested.inverted ? expr.consequent : expr.alternate;
  const presentText = sourceCode
    .getText(unwrapExpression(presentBranch))
    .replace(/\s+/gu, "");
  if (
    presentText !== tested.candidateText &&
    !presentText.startsWith(`${tested.candidateText}.`)
  ) {
    return null;
  }
  return { presentBranch, fallbackBranch };
}

function isValueFallbackExpression(node, sourceCode, depth = 0) {
  if (depth > 4) return false;
  const expr = unwrapExpression(node);
  if (!expr) return false;
  if (
    expr.type === "LogicalExpression" &&
    (expr.operator === "??" || expr.operator === "||")
  ) {
    return !isPureBooleanDisjunction(expr, sourceCode);
  }
  if (extractValueFallbackTernary(expr, sourceCode) !== null) {
    return true;
  }
  if (expr.type === "Identifier") {
    const init = constInitializer(sourceCode, expr);
    return init
      ? isValueFallbackExpression(init, sourceCode, depth + 1)
      : false;
  }
  return false;
}

function unwrapCallbackReturn(callbackNode) {
  if (callbackNode.body?.type === "BlockStatement") {
    const returnStmt = callbackNode.body.body.find(
      (stmt) => stmt.type === "ReturnStatement"
    );
    return unwrapExpression(returnStmt?.argument);
  }
  return unwrapExpression(callbackNode.body);
}

function isFindPresencePredicate(arg) {
  const pred = unwrapExpression(arg);
  if (!pred) return false;
  if (pred.type === "Identifier" && pred.name === "Boolean") return true;
  if (!isFunctionLike(pred) || pred.params.length === 0) return false;
  const firstParam = pred.params[0];
  if (firstParam?.type !== "Identifier") return false;
  const unwrapped = unwrapCallbackReturn(pred);
  if (!unwrapped) return false;
  if (unwrapped.type === "Identifier" && unwrapped.name === firstParam.name) {
    return true;
  }
  if (
    unwrapped.type === "CallExpression" &&
    unwrapped.callee?.type === "Identifier" &&
    unwrapped.callee.name === "Boolean" &&
    unwrapped.arguments[0]?.type === "Identifier" &&
    unwrapped.arguments[0].name === firstParam.name
  ) {
    return true;
  }
  return (
    unwrapped.type === "BinaryExpression" &&
    (unwrapped.operator === "!==" || unwrapped.operator === "!=") &&
    unwrapped.left?.type === "Identifier" &&
    unwrapped.left.name === firstParam.name &&
    isAbsenceLiteralOrNullish(unwrapped.right)
  );
}

function isHelperDisguiseCall(node) {
  const callee = unwrapExpression(node.callee);
  if (callee?.type === "Identifier" && COALESCE_HELPER_RE.test(callee.name)) {
    return node.arguments.length >= 2;
  }
  return (
    callee?.type === "MemberExpression" &&
    !callee.computed &&
    callee.property?.name === "find" &&
    callee.object?.type === "ArrayExpression" &&
    callee.object.elements.length >= 2 &&
    isFindPresencePredicate(node.arguments[0])
  );
}

function isLoopCoalesceHelperFunction(fnNode, sourceCode) {
  if (fnNode.body?.type !== "BlockStatement") return false;
  const firstStmt = fnNode.body.body[0];
  if (firstStmt?.type !== "ForOfStatement") return false;
  const loopBody =
    firstStmt.body.type === "BlockStatement"
      ? firstStmt.body.body[0]
      : firstStmt.body;
  if (loopBody?.type !== "IfStatement") return false;
  const retStmt =
    loopBody.consequent.type === "BlockStatement"
      ? loopBody.consequent.body[0]
      : loopBody.consequent;
  if (retStmt?.type !== "ReturnStatement" || !retStmt.argument) return false;
  const tested = extractTestedPresenceCandidate(loopBody.test, sourceCode);
  return (
    tested !== null &&
    !tested.inverted &&
    sourceCode.getText(retStmt.argument).replace(/\s+/gu, "") ===
      tested.candidateText
  );
}

function fallbackMutationTarget(stmt, sourceCode) {
  if (
    stmt.type === "ExpressionStatement" &&
    stmt.expression?.type === "AssignmentExpression" &&
    (stmt.expression.operator === "??=" ||
      stmt.expression.operator === "||=") &&
    stmt.expression.left?.type === "Identifier"
  ) {
    return stmt.expression.left.name;
  }
  if (stmt.type !== "IfStatement" || stmt.alternate) return null;
  const tested = extractTestedPresenceCandidate(stmt.test, sourceCode);
  const innerStmt =
    stmt.consequent.type === "BlockStatement"
      ? stmt.consequent.body[0]
      : stmt.consequent;
  if (
    tested?.inverted &&
    innerStmt?.type === "ExpressionStatement" &&
    innerStmt.expression?.type === "AssignmentExpression" &&
    innerStmt.expression.operator === "=" &&
    innerStmt.expression.left?.type === "Identifier" &&
    innerStmt.expression.left.name === tested.candidateText
  ) {
    return tested.candidateText;
  }
  return null;
}

function checkBlockFallbackCascade(blockNode, context) {
  const sourceCode = context.sourceCode;
  const fallbackWriteCounts = new Map();
  for (const stmt of blockNode.body ?? []) {
    if (stmt.type === "VariableDeclaration") {
      for (const decl of stmt.declarations) {
        if (
          decl.id?.type === "Identifier" &&
          decl.init &&
          isValueFallbackExpression(decl.init, sourceCode)
        ) {
          fallbackWriteCounts.set(decl.id.name, 1);
        }
      }
      continue;
    }
    const targetName = fallbackMutationTarget(stmt, sourceCode);
    if (!targetName) continue;
    const count = (fallbackWriteCounts.get(targetName) ?? 0) + 1;
    fallbackWriteCounts.set(targetName, count);
    if (count === 2) {
      context.report({ node: stmt, messageId: "fallbackChain" });
    }
  }
}

function checkLogicalFallbackChain(node, context) {
  const sourceCode = context.sourceCode;
  if (node.operator !== "??" && node.operator !== "||") return;
  const parent = node.parent;
  if (
    parent?.type === "LogicalExpression" &&
    (parent.operator === "??" || parent.operator === "||")
  ) {
    return;
  }
  if (isPureBooleanDisjunction(node, sourceCode)) return;
  const { operators, leaves } = collectCoalesceChain(node);
  const hasChainedOperators = operators.length >= 2;
  const hasFallbackLeaf = leaves.some((leaf) => {
    if (leaf?.type === "Identifier") {
      const init = constInitializer(sourceCode, leaf);
      return init ? isValueFallbackExpression(init, sourceCode) : false;
    }
    return extractValueFallbackTernary(leaf, sourceCode) !== null;
  });
  if (hasChainedOperators || hasFallbackLeaf) {
    context.report({ node, messageId: "fallbackChain" });
  }
}

function checkConditionalFallbackChain(node, context) {
  if (node.parent?.type === "ConditionalExpression") return;
  const sourceCode = context.sourceCode;
  const ternary = extractValueFallbackTernary(node, sourceCode);
  if (!ternary) return;
  if (
    isValueFallbackExpression(ternary.fallbackBranch, sourceCode) ||
    (ternary.presentBranch?.type === "Identifier" &&
      isValueFallbackExpression(ternary.presentBranch, sourceCode))
  ) {
    context.report({ node, messageId: "fallbackChain" });
  }
}

export default function ruleNoFallbackChain() {
  return {
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow chained value-selection fallbacks across multiple sources, including equivalent ternaries and helper disguises.",
      },
      schema: [],
      messages: {
        fallbackChain:
          "Chained fallback value selection across multiple candidate sources is forbidden; resolve one authoritative owner or decode once at the boundary.",
      },
    },
    create(context) {
      const sourceCode = context.sourceCode;
      return {
        LogicalExpression: (node) => checkLogicalFallbackChain(node, context),
        ConditionalExpression: (node) =>
          checkConditionalFallbackChain(node, context),
        CallExpression(node) {
          if (isHelperDisguiseCall(node)) {
            context.report({ node, messageId: "fallbackChain" });
          }
        },
        FunctionDeclaration(node) {
          if (isLoopCoalesceHelperFunction(node, sourceCode)) {
            context.report({ node, messageId: "fallbackChain" });
          }
        },
        BlockStatement: (node) => checkBlockFallbackCascade(node, context),
        Program: (node) => checkBlockFallbackCascade(node, context),
      };
    },
  };
}
