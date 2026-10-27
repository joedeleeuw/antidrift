import {
  getPropertyName,
  isAstNode,
  isIdentifier,
  isStringLiteral,
  unwrapExpression,
} from "./ast.js";

export const unwrapReaderExpression = (node) => {
  let current = unwrapExpression(node);
  while (
    current !== null &&
    (current.type === "TSNonNullExpression" ||
      current.type === "TSTypeAssertion")
  ) {
    current = unwrapExpression(current.expression);
  }
  return current;
};

export const FUNCTION_TYPES = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
]);
const LOOP_TYPES = new Set([
  "DoWhileStatement",
  "ForInStatement",
  "ForOfStatement",
  "ForStatement",
  "WhileStatement",
]);
export const nearestFunctionOrProgram = (node) => {
  let current = isAstNode(node) ? node : null;
  while (current !== null) {
    if (FUNCTION_TYPES.has(current.type) || current.type === "Program") {
      return current;
    }
    current = isAstNode(current.parent) ? current.parent : null;
  }
  return null;
};
export const isDescendantOf = (node, ancestor) => {
  let current = isAstNode(node) ? node : null;
  while (current !== null) {
    if (current === ancestor) {
      return true;
    }
    current = isAstNode(current.parent) ? current.parent : null;
  }
  return false;
};
export const statementSite = (node) => {
  let current = isAstNode(node) ? node : null;
  while (current !== null) {
    const parent = isAstNode(current.parent) ? current.parent : null;
    if (
      parent !== null &&
      (parent.type === "BlockStatement" || parent.type === "Program") &&
      Array.isArray(parent.body) &&
      parent.body.includes(current)
    ) {
      return { block: parent, statement: current };
    }
    current = parent;
  }
  return null;
};
export const visitNodes = (node, root, visitor, seen = new Set()) => {
  if (!isAstNode(node) || seen.has(node)) {
    return;
  }
  seen.add(node);
  if (node !== root && FUNCTION_TYPES.has(node.type)) {
    return;
  }
  visitor(node);
  for (const [key, child] of Object.entries(node)) {
    if (key === "parent") {
      continue;
    }
    if (Array.isArray(child)) {
      for (const nestedChild of child) {
        visitNodes(nestedChild, root, visitor, seen);
      }
      continue;
    }
    visitNodes(child, root, visitor, seen);
  }
};
export const staticMemberName = (node) => {
  if (node.type !== "MemberExpression") {
    return null;
  }
  if (node.computed === true) {
    return isStringLiteral(node.property) ? node.property.value : null;
  }
  return getPropertyName(node.property);
};
export const memberCall = (node, method) => {
  const call = unwrapReaderExpression(node);
  if (call === null || call.type !== "CallExpression") {
    return null;
  }
  const callee = unwrapReaderExpression(call.callee);
  if (
    callee === null ||
    callee.type !== "MemberExpression" ||
    staticMemberName(callee) !== method
  ) {
    return null;
  }
  return { call, object: callee.object };
};
export const callWithinExpressionStatement = (
  statement,
  predicate,
  canAssign
) => {
  if (!isAstNode(statement) || statement.type !== "ExpressionStatement") {
    return false;
  }
  const containsUnconditionalCall = (node) => {
    const expression = unwrapReaderExpression(node);
    if (expression === null) {
      return false;
    }
    if (expression.type === "AwaitExpression") {
      return containsUnconditionalCall(expression.argument);
    }
    if (
      expression.type === "AssignmentExpression" &&
      expression.operator === "=" &&
      canAssign(expression.left)
    ) {
      return containsUnconditionalCall(expression.right);
    }
    if (
      expression.type === "CallExpression" &&
      (expression.optional !== true ||
        (expression.callee.type === "MemberExpression" &&
          expression.callee.optional !== true &&
          staticMemberName(expression.callee) === "releaseLock"))
    ) {
      if (predicate(expression)) {
        return true;
      }
      const callee = unwrapReaderExpression(expression.callee);
      if (
        callee?.type === "MemberExpression" &&
        callee.optional !== true &&
        containsUnconditionalCall(callee.object)
      ) {
        return true;
      }
      return Array.isArray(expression.arguments)
        ? expression.arguments.some(containsUnconditionalCall)
        : false;
    }
    if (
      expression.type === "SequenceExpression" &&
      Array.isArray(expression.expressions)
    ) {
      for (const sequenceExpression of expression.expressions) {
        if (containsUnconditionalCall(sequenceExpression)) {
          return true;
        }
        const preceding = unwrapReaderExpression(sequenceExpression);
        if (
          preceding === null ||
          (preceding.type !== "Identifier" &&
            preceding.type !== "Literal" &&
            preceding.type !== "ThisExpression")
        ) {
          return false;
        }
      }
    }
    return false;
  };
  return containsUnconditionalCall(statement.expression);
};
const abruptCompletionTarget = (node) => {
  if (node.type !== "BreakStatement" && node.type !== "ContinueStatement") {
    return null;
  }
  const labelName = isIdentifier(node.label) ? node.label.name : null;
  let current = isAstNode(node.parent) ? node.parent : null;
  while (current !== null) {
    if (
      labelName !== null &&
      current.type === "LabeledStatement" &&
      isIdentifier(current.label, labelName)
    ) {
      return current;
    }
    if (
      labelName === null &&
      (LOOP_TYPES.has(current.type) ||
        (node.type === "BreakStatement" && current.type === "SwitchStatement"))
    ) {
      return current;
    }
    if (FUNCTION_TYPES.has(current.type)) {
      return null;
    }
    current = isAstNode(current.parent) ? current.parent : null;
  }
  return null;
};
export const nearestLoopWithin = (node, boundary) => {
  let current = isAstNode(node) ? node.parent : null;
  while (isAstNode(current) && current !== boundary) {
    if (LOOP_TYPES.has(current.type)) {
      return current;
    }
    if (FUNCTION_TYPES.has(current.type)) {
      return null;
    }
    current = current.parent;
  }
  return null;
};
const isLiteralTrue = (node) => {
  const expression = unwrapReaderExpression(node);
  return (
    expression !== null &&
    expression.type === "Literal" &&
    expression.value === true
  );
};
export const isInfiniteLoop = (node) => {
  if (node.type === "ForStatement") {
    return node.test === null;
  }
  return (
    (node.type === "WhileStatement" || node.type === "DoWhileStatement") &&
    isLiteralTrue(node.test)
  );
};
export const breakExitsLoop = (node, loop) => {
  const target = abruptCompletionTarget(node);
  return target !== null && isDescendantOf(loop, target);
};
