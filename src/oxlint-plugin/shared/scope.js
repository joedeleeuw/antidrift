import { resolveOwnerStatusValues } from "../owned-union-source.js";

const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

const EXPRESSION_WRAPPERS = new Set([
  "ChainExpression",
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSTypeAssertion",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
]);

export function isFunctionLike(node) {
  return Boolean(node && FUNCTION_TYPES.has(node.type));
}

export function unwrapExpression(node) {
  let current = node;
  while (current && EXPRESSION_WRAPPERS.has(current.type)) {
    current = current.expression;
  }
  return current;
}

export function isTypeOnlyModule(node) {
  if (!node || typeof node !== "object") return false;
  if (node.importKind === "type" || node.exportKind === "type") return true;
  if (
    node.type === "ImportDeclaration" &&
    Array.isArray(node.specifiers) &&
    node.specifiers.length > 0 &&
    node.specifiers.every(
      (spec) => spec.type === "ImportSpecifier" && spec.importKind === "type"
    )
  ) {
    return true;
  }
  if (
    node.type === "ExportNamedDeclaration" &&
    Array.isArray(node.specifiers) &&
    node.specifiers.length > 0 &&
    node.specifiers.every(
      (spec) => spec.type === "ExportSpecifier" && spec.exportKind === "type"
    )
  ) {
    return true;
  }
  return false;
}

export function findVariable(sourceCode, identifier) {
  if (!identifier || identifier.type !== "Identifier") return null;
  let scope = sourceCode?.getScope?.(identifier);
  while (scope) {
    const binding = scope.set?.get?.(identifier.name);
    if (binding) return binding;
    scope = scope.upper;
  }
  return null;
}

export function splitIdentifierWords(name) {
  if (typeof name !== "string" || name.length === 0) return [];
  return name
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
    .split(/[^A-Za-z0-9]+/u)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

function isJsxNode(node) {
  const unwrapped = unwrapExpression(node);
  return Boolean(
    unwrapped &&
    (unwrapped.type === "JSXElement" || unwrapped.type === "JSXFragment")
  );
}

function expressionContainsJsx(node) {
  if (!node || typeof node !== "object") return false;
  const unwrapped = unwrapExpression(node);
  if (isJsxNode(unwrapped)) return true;
  if (unwrapped.type === "ConditionalExpression") {
    return (
      expressionContainsJsx(unwrapped.consequent) ||
      expressionContainsJsx(unwrapped.alternate)
    );
  }
  if (unwrapped.type === "LogicalExpression") {
    return (
      expressionContainsJsx(unwrapped.left) ||
      expressionContainsJsx(unwrapped.right)
    );
  }
  return false;
}

function statementReturnsJsx(stmt) {
  if (!stmt || typeof stmt !== "object") return false;
  if (stmt.type === "ReturnStatement") {
    return expressionContainsJsx(stmt.argument);
  }
  if (stmt.type === "BlockStatement" && Array.isArray(stmt.body)) {
    return stmt.body.some(statementReturnsJsx);
  }
  if (stmt.type === "IfStatement") {
    return (
      statementReturnsJsx(stmt.consequent) ||
      statementReturnsJsx(stmt.alternate)
    );
  }
  if (stmt.type === "SwitchStatement" && Array.isArray(stmt.cases)) {
    return stmt.cases.some((c) => c.consequent?.some(statementReturnsJsx));
  }
  if (stmt.type === "TryStatement") {
    return (
      statementReturnsJsx(stmt.block) ||
      statementReturnsJsx(stmt.handler?.body) ||
      statementReturnsJsx(stmt.finalizer)
    );
  }
  return false;
}

export function functionReturnsJsx(fnNode) {
  if (!isFunctionLike(fnNode)) return false;
  if (fnNode.body?.type === "BlockStatement") {
    return statementReturnsJsx(fnNode.body);
  }
  return expressionContainsJsx(fnNode.body);
}

const TYPE_DECLARATION_TYPES = new Set([
  "TSTypeAliasDeclaration",
  "TSInterfaceDeclaration",
]);

export function normalizedContextName(contextName) {
  return (contextName ?? "").replace(/[^a-z0-9]/giu, "").toLowerCase();
}

export function isStatusContextName(contextName, statusName) {
  const normalized = normalizedContextName(contextName);
  return (
    normalized.length > 0 && normalized === normalizedContextName(statusName)
  );
}

function nodeKeyName(node) {
  if (node?.type === "Identifier" || node?.type === "PrivateIdentifier") {
    return node.name ?? "";
  }
  if (node?.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  return "";
}

function declaredName(node) {
  return typeof node?.id?.name === "string" ? node.id.name : "";
}

function enclosingTypeDeclarationName(node) {
  for (let current = node?.parent; current; current = current.parent) {
    if (TYPE_DECLARATION_TYPES.has(current.type)) {
      return declaredName(current);
    }
  }
  return "";
}

function isStatusLiteralContext(node, statusName) {
  const statusKey = normalizedContextName(statusName);
  for (let current = node?.parent; current; current = current.parent) {
    if (current.type === "TSPropertySignature") {
      const keyName = nodeKeyName(current.key);
      if (
        normalizedContextName(keyName) === statusKey &&
        statusKey.length > 0
      ) {
        return true;
      }
      const ownerName = enclosingTypeDeclarationName(current);
      return (
        ownerName.length > 0 &&
        normalizedContextName(`${ownerName}${keyName}`) === statusKey
      );
    }
    if (TYPE_DECLARATION_TYPES.has(current.type)) {
      return normalizedContextName(declaredName(current)) === statusKey;
    }
    if (current.type === "Identifier") {
      return normalizedContextName(current.name) === statusKey;
    }
    if (
      current.type === "VariableDeclarator" &&
      current.id?.type === "Identifier"
    ) {
      return normalizedContextName(current.id.name) === statusKey;
    }
  }
  return false;
}

export function canonicalStatusLiteralOwner(node, statuses) {
  const literalText = node?.literal?.value;
  if (
    typeof literalText !== "string" ||
    typeof statuses !== "object" ||
    !statuses
  ) {
    return null;
  }
  for (const [name, entry] of Object.entries(statuses)) {
    const literals = resolveOwnerStatusValues(name, entry);
    if (literals.includes(literalText) && isStatusLiteralContext(node, name)) {
      const owner = entry?.owner;
      if (typeof owner !== "string") {
        throw new TypeError(`statuses.${name}.owner must be a string`);
      }
      return { name, owner, values: literals, value: literalText };
    }
  }
  return null;
}
