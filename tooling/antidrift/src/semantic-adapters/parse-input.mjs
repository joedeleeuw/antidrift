const TS_TYPE_FLAG_ANY = 1;
const TS_TYPE_FLAG_UNKNOWN = 2;

export function unwrapExpression(expression) {
  if (expression?.type === "ChainExpression") return expression.expression;
  if (expression?.type === "TSAsExpression") {
    return unwrapExpression(expression.expression);
  }
  if (expression?.type === "TSNonNullExpression") {
    return unwrapExpression(expression.expression);
  }
  if (expression?.type === "TSSatisfiesExpression") {
    return unwrapExpression(expression.expression);
  }
  return expression;
}

export function sameExpression(left, right) {
  const a = unwrapExpression(left);
  const b = unwrapExpression(right);
  if (!a || !b || a.type !== b.type) return false;
  if (a.type === "Identifier") return a.name === b.name;
  if (a.type === "ThisExpression" || a.type === "Super") return true;
  if (a.type === "Literal") return a.value === b.value;
  if (a.type !== "MemberExpression") return false;
  if (a.computed !== b.computed || !sameExpression(a.object, b.object)) {
    return false;
  }
  if (a.computed) return sameExpression(a.property, b.property);
  if (a.property?.type === "Identifier" && b.property?.type === "Identifier") {
    return a.property.name === b.property.name;
  }
  return (
    a.property?.type === "PrivateIdentifier" &&
    b.property?.type === "PrivateIdentifier" &&
    a.property.name === b.property.name
  );
}

export function isStringLiteralNode(node) {
  const unwrapped = unwrapExpression(node);
  return unwrapped?.type === "Literal" && unwrapped.value === "string";
}

export function typeofOperand(node) {
  const unwrapped = unwrapExpression(node);
  return unwrapped?.type === "UnaryExpression" &&
    unwrapped.operator === "typeof"
    ? unwrapExpression(unwrapped.argument)
    : null;
}

export function stringTypeofGuard(condition, expression) {
  const node = unwrapExpression(condition);
  if (
    !node ||
    node.type !== "BinaryExpression" ||
    !["==", "===", "!=", "!=="].includes(node.operator)
  ) {
    return null;
  }
  const leftTypeof = typeofOperand(node.left);
  const rightTypeof = typeofOperand(node.right);
  let operand = null;
  if (leftTypeof && isStringLiteralNode(node.right)) operand = leftTypeof;
  else if (rightTypeof && isStringLiteralNode(node.left)) operand = rightTypeof;
  if (!operand || !sameExpression(operand, expression)) return null;
  const equals = node.operator === "==" || node.operator === "===";
  return { truthy: equals, falsy: !equals };
}

export function conditionEnsuresString(condition, expression, whenTruthy) {
  const node = unwrapExpression(condition);
  if (!node) return false;
  const direct = stringTypeofGuard(node, expression);
  if (direct) return whenTruthy ? direct.truthy : direct.falsy;
  if (node.type === "UnaryExpression" && node.operator === "!") {
    return conditionEnsuresString(node.argument, expression, !whenTruthy);
  }
  if (node.type !== "LogicalExpression") return false;
  if (node.operator === "&&") {
    if (whenTruthy) {
      return (
        conditionEnsuresString(node.left, expression, true) ||
        conditionEnsuresString(node.right, expression, true)
      );
    }
    return (
      conditionEnsuresString(node.left, expression, false) &&
      conditionEnsuresString(node.right, expression, false)
    );
  }
  if (node.operator === "||") {
    if (whenTruthy) {
      return (
        conditionEnsuresString(node.left, expression, true) &&
        conditionEnsuresString(node.right, expression, true)
      );
    }
    return (
      conditionEnsuresString(node.left, expression, false) ||
      conditionEnsuresString(node.right, expression, false)
    );
  }
  return false;
}

export function nodeWithin(node, ancestor) {
  let cur = node;
  while (cur) {
    if (cur === ancestor) return true;
    cur = cur.parent;
  }
  return false;
}

export function statementAlwaysExits(statement) {
  if (!statement) return false;
  if (
    statement.type === "ReturnStatement" ||
    statement.type === "ThrowStatement" ||
    statement.type === "ContinueStatement" ||
    statement.type === "BreakStatement"
  ) {
    return true;
  }
  if (statement.type === "BlockStatement") {
    return (
      statement.body.length > 0 &&
      statementAlwaysExits(statement.body[statement.body.length - 1])
    );
  }
  if (statement.type === "IfStatement") {
    return (
      statementAlwaysExits(statement.consequent) &&
      statementAlwaysExits(statement.alternate)
    );
  }
  return false;
}

export function enclosingBlockStatement(node) {
  let cur = node;
  while (cur?.parent) {
    if (cur.parent.type === "BlockStatement" && cur.parent.body.includes(cur)) {
      return cur;
    }
    cur = cur.parent;
  }
  return null;
}

export function safeBetweenStringGuardAndParse(statement) {
  return (
    statement?.type === "VariableDeclaration" &&
    statement.declarations.every((declaration) => declaration.init == null)
  );
}

export function previousGuardInBlockEnsuresString(statement, expression) {
  const block = statement?.parent;
  if (!statement || block?.type !== "BlockStatement") return false;
  const index = block.body.indexOf(statement);
  let previousIndex = index - 1;
  while (
    previousIndex >= 0 &&
    safeBetweenStringGuardAndParse(block.body[previousIndex])
  ) {
    previousIndex -= 1;
  }
  const previous = previousIndex >= 0 ? block.body[previousIndex] : null;
  if (previous?.type !== "IfStatement") return false;
  if (
    statementAlwaysExits(previous.consequent) &&
    conditionEnsuresString(previous.test, expression, false)
  ) {
    return true;
  }
  return Boolean(
    previous.alternate &&
    statementAlwaysExits(previous.alternate) &&
    conditionEnsuresString(previous.test, expression, true),
  );
}

export function priorGuardEnsuresString(node, expression) {
  let cur = node;
  while (cur) {
    const statement = enclosingBlockStatement(cur);
    if (!statement) return false;
    if (previousGuardInBlockEnsuresString(statement, expression)) return true;
    const blockOwner = statement.parent?.parent;
    if (
      blockOwner?.type === "FunctionDeclaration" ||
      blockOwner?.type === "FunctionExpression" ||
      blockOwner?.type === "ArrowFunctionExpression"
    ) {
      return false;
    }
    cur = blockOwner;
  }
  return false;
}

export function branchGuardEnsuresString(node, expression) {
  let cur = node.parent;
  while (cur) {
    if (cur.type === "IfStatement") {
      if (
        nodeWithin(node, cur.consequent) &&
        conditionEnsuresString(cur.test, expression, true)
      ) {
        return true;
      }
      if (
        cur.alternate &&
        nodeWithin(node, cur.alternate) &&
        conditionEnsuresString(cur.test, expression, false)
      ) {
        return true;
      }
    }
    cur = cur.parent;
  }
  return false;
}

export function hasLocalStringBoundary(node, expression) {
  return (
    branchGuardEnsuresString(node, expression) ||
    priorGuardEnsuresString(node, expression)
  );
}

export function isAnyOrUnknownType(type) {
  return Boolean(
    type && type.flags & (TS_TYPE_FLAG_ANY | TS_TYPE_FLAG_UNKNOWN),
  );
}

export function isJsonParseCall(node) {
  const callee = node?.callee;
  return Boolean(
    node?.type === "CallExpression" &&
      callee?.type === "MemberExpression" &&
      callee.object?.type === "Identifier" &&
      callee.object.name === "JSON" &&
      callee.property?.type === "Identifier" &&
      callee.property.name === "parse",
  );
}

export function jsonParseArgument(node) {
  return isJsonParseCall(node) ? (node.arguments[0] ?? null) : null;
}

export function isUnsafeJsonParseInput(node, services, checker) {
  const arg = jsonParseArgument(node);
  if (!arg) return false;
  const tsArg = services.esTreeNodeToTSNodeMap.get(arg);
  return Boolean(
    tsArg &&
      isAnyOrUnknownType(checker.getTypeAtLocation(tsArg)) &&
      !hasLocalStringBoundary(node, arg),
  );
}
