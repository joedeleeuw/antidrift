import ts from "typescript";

import type { TypeScriptParserServices } from "../kernel/rule-kernel.ts";
import { isFunctionLike } from "../kernel/syntax-function.ts";
import type { SyntaxNode } from "../kernel/syntax-node.ts";
import {
  identifierName,
  isSyntaxNode,
  isSyntaxType,
  isSyntaxTypeIn,
  syntaxChildren,
  syntaxField,
  syntaxText,
  unwrapExpression,
} from "../kernel/syntax-node.ts";

export type { TypeScriptParserServices } from "../kernel/rule-kernel.ts";
export { unwrapExpression } from "../kernel/syntax-node.ts";

export type StringTypeofGuard = {
  readonly truthy: boolean;
  readonly falsy: boolean;
};

const EQUALITY_OPERATORS = new Set(["==", "===", "!=", "!=="]);

const EXITING_STATEMENT_TYPES = new Set([
  "ReturnStatement",
  "ThrowStatement",
  "ContinueStatement",
  "BreakStatement",
]);

const ANY_OR_UNKNOWN_FLAGS = ts.TypeFlags.Any | ts.TypeFlags.Unknown;

function sameMemberProperty(left: SyntaxNode, right: SyntaxNode): boolean {
  const leftProperty = syntaxField(left, "property");
  const rightProperty = syntaxField(right, "property");
  if (syntaxField(left, "computed") === true) {
    return sameExpression(leftProperty, rightProperty);
  }
  return (
    isSyntaxNode(leftProperty) &&
    isSyntaxNode(rightProperty) &&
    leftProperty.type === rightProperty.type &&
    (leftProperty.type === "Identifier" ||
      leftProperty.type === "PrivateIdentifier") &&
    syntaxField(leftProperty, "name") === syntaxField(rightProperty, "name")
  );
}

export function sameExpression(left: unknown, right: unknown): boolean {
  const leftNode = unwrapExpression(left);
  const rightNode = unwrapExpression(right);
  if (
    !isSyntaxNode(leftNode) ||
    !isSyntaxNode(rightNode) ||
    leftNode.type !== rightNode.type
  ) {
    return false;
  }
  if (leftNode.type === "Identifier") {
    return syntaxField(leftNode, "name") === syntaxField(rightNode, "name");
  }
  if (leftNode.type === "ThisExpression" || leftNode.type === "Super") {
    return true;
  }
  if (leftNode.type === "Literal") {
    return syntaxField(leftNode, "value") === syntaxField(rightNode, "value");
  }
  return (
    leftNode.type === "MemberExpression" &&
    syntaxField(leftNode, "computed") === syntaxField(rightNode, "computed") &&
    sameExpression(
      syntaxField(leftNode, "object"),
      syntaxField(rightNode, "object")
    ) &&
    sameMemberProperty(leftNode, rightNode)
  );
}

export function isStringLiteralNode(node: unknown): boolean {
  const unwrapped = unwrapExpression(node);
  return (
    isSyntaxType(unwrapped, "Literal") &&
    syntaxField(unwrapped, "value") === "string"
  );
}

export function typeofOperand(node: unknown) {
  const unwrapped = unwrapExpression(node);
  return isSyntaxType(unwrapped, "UnaryExpression") &&
    syntaxField(unwrapped, "operator") === "typeof"
    ? unwrapExpression(syntaxField(unwrapped, "argument"))
    : null;
}

function guardedOperand(binary: SyntaxNode) {
  const left = syntaxField(binary, "left");
  const right = syntaxField(binary, "right");
  const leftTypeof = typeofOperand(left);
  if (leftTypeof && isStringLiteralNode(right)) {
    return leftTypeof;
  }
  const rightTypeof = typeofOperand(right);
  return rightTypeof && isStringLiteralNode(left) ? rightTypeof : null;
}

export function stringTypeofGuard(
  condition: unknown,
  expression: unknown
): StringTypeofGuard | null {
  const node = unwrapExpression(condition);
  const operator = syntaxText(node, "operator");
  if (
    !isSyntaxType(node, "BinaryExpression") ||
    operator === null ||
    !EQUALITY_OPERATORS.has(operator)
  ) {
    return null;
  }
  const operand = guardedOperand(node);
  if (!operand || !sameExpression(operand, expression)) {
    return null;
  }
  const equals = operator === "==" || operator === "===";
  return { truthy: equals, falsy: !equals };
}

function logicalEnsuresString(
  node: SyntaxNode,
  expression: unknown,
  whenTruthy: boolean
): boolean {
  const operator = syntaxField(node, "operator");
  if (operator !== "&&" && operator !== "||") {
    return false;
  }
  const requiresBoth = (operator === "&&") !== whenTruthy;
  const left = conditionEnsuresString(
    syntaxField(node, "left"),
    expression,
    whenTruthy
  );
  const right = syntaxField(node, "right");
  return requiresBoth
    ? left && conditionEnsuresString(right, expression, whenTruthy)
    : left || conditionEnsuresString(right, expression, whenTruthy);
}

export function conditionEnsuresString(
  condition: unknown,
  expression: unknown,
  whenTruthy: boolean
): boolean {
  const node = unwrapExpression(condition);
  if (!isSyntaxNode(node)) {
    return false;
  }
  const direct = stringTypeofGuard(node, expression);
  if (direct) {
    return whenTruthy ? direct.truthy : direct.falsy;
  }
  if (
    node.type === "UnaryExpression" &&
    syntaxField(node, "operator") === "!"
  ) {
    return conditionEnsuresString(
      syntaxField(node, "argument"),
      expression,
      !whenTruthy
    );
  }
  return (
    node.type === "LogicalExpression" &&
    logicalEnsuresString(node, expression, whenTruthy)
  );
}

export function nodeWithin(node: unknown, ancestor: unknown): boolean {
  for (
    let current = node;
    isSyntaxNode(current);
    current = syntaxField(current, "parent")
  ) {
    if (current === ancestor) {
      return true;
    }
  }
  return false;
}

export function statementAlwaysExits(statement: unknown): boolean {
  if (isSyntaxTypeIn(statement, EXITING_STATEMENT_TYPES)) {
    return true;
  }
  if (isSyntaxType(statement, "BlockStatement")) {
    return statementAlwaysExits(syntaxChildren(statement, "body").at(-1));
  }
  return (
    isSyntaxType(statement, "IfStatement") &&
    statementAlwaysExits(syntaxField(statement, "consequent")) &&
    statementAlwaysExits(syntaxField(statement, "alternate"))
  );
}

export function enclosingBlockStatement(node: unknown) {
  let current = node;
  let parent = syntaxField(current, "parent");
  while (isSyntaxNode(parent)) {
    if (
      parent.type === "BlockStatement" &&
      syntaxChildren(parent, "body").includes(current)
    ) {
      return current;
    }
    current = parent;
    parent = syntaxField(current, "parent");
  }
  return null;
}

export function safeBetweenStringGuardAndParse(statement: unknown): boolean {
  return (
    isSyntaxType(statement, "VariableDeclaration") &&
    syntaxChildren(statement, "declarations").every(
      (declaration) => syntaxField(declaration, "init") == null
    )
  );
}

function previousStatement(body: readonly unknown[], statement: unknown) {
  let previousIndex = body.indexOf(statement) - 1;
  while (
    previousIndex >= 0 &&
    safeBetweenStringGuardAndParse(body[previousIndex])
  ) {
    previousIndex -= 1;
  }
  return previousIndex >= 0 ? body[previousIndex] : null;
}

export function previousGuardInBlockEnsuresString(
  statement: unknown,
  expression: unknown
): boolean {
  const block = syntaxField(statement, "parent");
  if (!isSyntaxType(block, "BlockStatement")) {
    return false;
  }
  const previous = previousStatement(syntaxChildren(block, "body"), statement);
  if (!isSyntaxType(previous, "IfStatement")) {
    return false;
  }
  const test = syntaxField(previous, "test");
  if (
    statementAlwaysExits(syntaxField(previous, "consequent")) &&
    conditionEnsuresString(test, expression, false)
  ) {
    return true;
  }
  return (
    statementAlwaysExits(syntaxField(previous, "alternate")) &&
    conditionEnsuresString(test, expression, true)
  );
}

export function priorGuardEnsuresString(
  node: unknown,
  expression: unknown
): boolean {
  for (let current = node; current; ) {
    const statement = enclosingBlockStatement(current);
    if (!statement) {
      return false;
    }
    if (previousGuardInBlockEnsuresString(statement, expression)) {
      return true;
    }
    const blockOwner = syntaxField(syntaxField(statement, "parent"), "parent");
    if (isFunctionLike(blockOwner)) {
      return false;
    }
    current = blockOwner;
  }
  return false;
}

function ifBranchEnsuresString(
  ifStatement: SyntaxNode,
  node: unknown,
  expression: unknown
): boolean {
  const test = syntaxField(ifStatement, "test");
  const alternate = syntaxField(ifStatement, "alternate");
  return (
    (nodeWithin(node, syntaxField(ifStatement, "consequent")) &&
      conditionEnsuresString(test, expression, true)) ||
    (nodeWithin(node, alternate) &&
      conditionEnsuresString(test, expression, false))
  );
}

export function branchGuardEnsuresString(
  node: unknown,
  expression: unknown
): boolean {
  for (
    let current = syntaxField(node, "parent");
    isSyntaxNode(current);
    current = syntaxField(current, "parent")
  ) {
    if (
      current.type === "IfStatement" &&
      ifBranchEnsuresString(current, node, expression)
    ) {
      return true;
    }
  }
  return false;
}

export function hasLocalStringBoundary(
  node: unknown,
  expression: unknown
): boolean {
  return (
    branchGuardEnsuresString(node, expression) ||
    priorGuardEnsuresString(node, expression)
  );
}

export function isAnyOrUnknownType(type: ts.Type | null | undefined): boolean {
  return Boolean(type && (type.flags & ANY_OR_UNKNOWN_FLAGS) !== 0);
}

export function isJsonParseCall(node: unknown): boolean {
  const callee = syntaxField(node, "callee");
  return (
    isSyntaxType(node, "CallExpression") &&
    isSyntaxType(callee, "MemberExpression") &&
    identifierName(syntaxField(callee, "object")) === "JSON" &&
    identifierName(syntaxField(callee, "property")) === "parse"
  );
}

export function jsonParseArgument(node: unknown) {
  return isJsonParseCall(node)
    ? (syntaxChildren(node, "arguments")[0] ?? null)
    : null;
}

export function isUnsafeJsonParseInput(
  node: unknown,
  services: TypeScriptParserServices,
  checker: ts.TypeChecker
): boolean {
  const argument = jsonParseArgument(node);
  const tsArgument = argument
    ? services.esTreeNodeToTSNodeMap.get(argument)
    : undefined;
  return (
    tsArgument !== undefined &&
    isAnyOrUnknownType(checker.getTypeAtLocation(tsArgument)) &&
    !hasLocalStringBoundary(node, argument)
  );
}
