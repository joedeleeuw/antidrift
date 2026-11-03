import { findVariable } from "./scope.js";
import { unwrapExpression } from "./test-files.js";

const runtimeSchemaLibrarySources = [
  "@effect/schema",
  "@sinclair/typebox",
  "arktype",
  "convex/values",
  "effect/Schema",
  "superstruct",
  "valibot",
  "yup",
  "zod",
];
const provenanceDepthLimit = 12;
export const schemaDiscriminantKeys = new Set([
  "kind",
  "type",
  "status",
  "tag",
  "_tag",
  "state",
  "mode",
  "phase",
  "variant",
]);

export function isRuntimeSchemaLibrarySource(value) {
  if (typeof value !== "string") return false;
  return runtimeSchemaLibrarySources.some(
    (source) => value === source || value.startsWith(`${source}/`)
  );
}

export function isRuntimeSchemaLibraryFile(fileName) {
  const normalized = fileName.replaceAll("\\", "/");
  const marker = "/node_modules/";
  const index = normalized.lastIndexOf(marker);
  return (
    index !== -1 &&
    isRuntimeSchemaLibrarySource(normalized.slice(index + marker.length))
  );
}

function importSource(identifier, sourceCode) {
  const definition = findVariable(sourceCode, identifier)?.defs?.[0];
  if (
    definition?.type !== "ImportBinding" ||
    definition.parent?.type !== "ImportDeclaration"
  ) {
    return null;
  }
  const source = definition.parent.source?.value;
  return typeof source === "string" ? source : null;
}

function constInitializer(identifier, sourceCode) {
  const definition = findVariable(sourceCode, identifier)?.defs?.[0];
  if (
    definition?.type !== "Variable" ||
    definition.node?.type !== "VariableDeclarator" ||
    definition.parent?.kind !== "const"
  ) {
    return null;
  }
  return definition.node.init ?? null;
}

export function hasRuntimeSchemaProvenance(
  expression,
  sourceCode,
  depth = 0,
  seen = new Set()
) {
  if (depth > provenanceDepthLimit) return false;
  const node = unwrapExpression(expression);
  if (!node || seen.has(node)) return false;
  seen.add(node);
  if (node.type === "Identifier") {
    if (isRuntimeSchemaLibrarySource(importSource(node, sourceCode))) {
      return true;
    }
    const initializer = constInitializer(node, sourceCode);
    return initializer
      ? hasRuntimeSchemaProvenance(initializer, sourceCode, depth + 1, seen)
      : false;
  }
  if (node.type === "MemberExpression") {
    return hasRuntimeSchemaProvenance(node.object, sourceCode, depth + 1, seen);
  }
  if (node.type === "CallExpression" || node.type === "NewExpression") {
    const callee = unwrapExpression(node.callee);
    return hasRuntimeSchemaProvenance(
      callee?.type === "MemberExpression" ? callee.object : callee,
      sourceCode,
      depth + 1,
      seen
    );
  }
  return false;
}

export function resolveSchemaBuilderCall(node, sourceCode) {
  if (
    node?.type !== "CallExpression" ||
    !hasRuntimeSchemaProvenance(node, sourceCode)
  ) {
    return null;
  }
  const callee = node.callee;
  let method = null;
  if (callee.type === "MemberExpression" && !callee.computed) {
    method = callee.property.name;
  }
  if (callee.type === "Identifier") method = callee.name;
  return method ? { method, args: node.arguments } : null;
}

export function resolveSchemaMemberChain(node, sourceCode) {
  if (!hasRuntimeSchemaProvenance(node, sourceCode)) return null;
  const steps = [];
  let root = unwrapExpression(node);
  while (root?.type === "CallExpression" || root?.type === "MemberExpression") {
    if (root.type === "MemberExpression") {
      root = unwrapExpression(root.object);
      continue;
    }
    const builder = resolveSchemaBuilderCall(root, sourceCode);
    if (!builder) return null;
    steps.unshift({ ...builder, node: root });
    root = unwrapExpression(
      root.callee.type === "MemberExpression" ? root.callee.object : root.callee
    );
  }
  return steps.length > 0 ? { root, steps } : null;
}

export function extractObjectFieldNames(objectExpr) {
  if (objectExpr?.type !== "ObjectExpression") return [];
  return objectExpr.properties
    .map(staticPropertyName)
    .filter((name) => name !== null);
}

export function staticPropertyName(property) {
  if (
    (property?.type !== "Property" &&
      property?.type !== "TSPropertySignature") ||
    property.computed
  ) {
    return null;
  }
  if (property.key.type === "Identifier") return property.key.name;
  return property.key.type === "Literal" &&
    typeof property.key.value === "string"
    ? property.key.value
    : null;
}
