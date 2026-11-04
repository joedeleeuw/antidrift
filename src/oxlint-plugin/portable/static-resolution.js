import {
  constInitializer,
  findVariable,
  unwrapExpression,
} from "../shared/scope.js";
import {
  getPropertyName,
  isIdentifier,
  isStringLiteral,
  staticTemplateText,
} from "./ast.js";

const BROWSER_GLOBAL_HOSTS = new Set(["globalThis", "self", "window"]);

export const isGlobalReference = (sourceCode, identifier, name) => {
  if (!isIdentifier(identifier, name) || !Array.isArray(identifier.range)) {
    return false;
  }
  const binding = findVariable(sourceCode, identifier);
  return binding === null || binding.defs.length === 0;
};

export const rootIdentifier = (node) => {
  const unwrapped = unwrapExpression(node);
  if (!unwrapped || typeof unwrapped.type !== "string") {
    return null;
  }
  if (unwrapped.type === "Identifier") {
    return unwrapped;
  }
  if (unwrapped.type === "MemberExpression") {
    return rootIdentifier(unwrapped.object);
  }
  if (unwrapped.type === "CallExpression") {
    return rootIdentifier(unwrapped.callee);
  }
  return null;
};

const isShorthandObjectProperty = (property) => {
  if (property.computed || property.key?.type !== "Identifier") {
    return false;
  }
  const target =
    property.value?.type === "AssignmentPattern"
      ? property.value.left
      : property.value;
  return target?.type === "Identifier" && target.name === property.key.name;
};

export function* patternIdentifiers(node, options = {}) {
  switch (node?.type) {
    case "Identifier":
      yield node;
      return;
    case "AssignmentPattern":
      yield* patternIdentifiers(node.left, options);
      return;
    case "RestElement":
      yield* patternIdentifiers(node.argument, options);
      return;
    case "ArrayPattern":
      for (const element of node.elements) {
        yield* patternIdentifiers(element, options);
      }
      return;
    case "ObjectPattern":
      for (const property of node.properties) {
        if (property.type === "RestElement") {
          yield* patternIdentifiers(property, options);
        } else if (
          options.skipShorthand !== true ||
          !isShorthandObjectProperty(property)
        ) {
          yield* patternIdentifiers(property.value, options);
        }
      }
      return;
    case "TSParameterProperty":
      yield* patternIdentifiers(node.parameter, options);
      break;
    default:
  }
}

export const resolveStaticString = (sourceCode, node, visited = new Set()) => {
  const expression = unwrapExpression(node);
  if (expression === null) {
    return null;
  }
  if (isStringLiteral(expression)) {
    return expression.value;
  }
  const templateText = staticTemplateText(expression);
  if (templateText !== null) {
    return templateText;
  }
  if (expression.type === "BinaryExpression" && expression.operator === "+") {
    const left = resolveStaticString(
      sourceCode,
      expression.left,
      new Set(visited)
    );
    const right = resolveStaticString(
      sourceCode,
      expression.right,
      new Set(visited)
    );
    return left === null || right === null ? null : left + right;
  }
  if (!isIdentifier(expression)) {
    return null;
  }
  const binding = findVariable(sourceCode, expression);
  if (binding === null || visited.has(binding)) {
    return null;
  }
  visited.add(binding);
  return resolveStaticString(
    sourceCode,
    constInitializer(sourceCode, expression),
    visited
  );
};

export const resolveStaticMemberName = (sourceCode, node) => {
  const member = unwrapExpression(node);
  if (member === null || member.type !== "MemberExpression") {
    return null;
  }
  return member.computed === true
    ? resolveStaticString(sourceCode, member.property)
    : getPropertyName(member.property);
};

export const isBrowserGlobalHost = (sourceCode, node, visited = new Set()) => {
  const expression = unwrapExpression(node);
  if (expression === null) {
    return false;
  }
  if (isIdentifier(expression)) {
    if (BROWSER_GLOBAL_HOSTS.has(expression.name)) {
      return isGlobalReference(sourceCode, expression);
    }
    const binding = findVariable(sourceCode, expression);
    if (binding === null || visited.has(binding)) {
      return false;
    }
    visited.add(binding);
    return isBrowserGlobalHost(
      sourceCode,
      constInitializer(sourceCode, expression),
      visited
    );
  }
  if (expression.type !== "MemberExpression") {
    return false;
  }
  const memberName = resolveStaticMemberName(sourceCode, expression);
  return (
    memberName !== null &&
    BROWSER_GLOBAL_HOSTS.has(memberName) &&
    isBrowserGlobalHost(sourceCode, expression.object, visited)
  );
};
