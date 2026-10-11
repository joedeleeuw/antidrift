import { findVariable } from "../../semantic-adapters/async-control-flow.mjs";
import { unwrapExpression } from "./test-files.js";

const runtimeSchemaLibrarySources = [
  "@effect/schema",
  "@sinclair/typebox",
  "arktype",
  "effect/Schema",
  "superstruct",
  "valibot",
  "yup",
  "zod",
];
const provenanceDepthLimit = 12;

export function isRuntimeSchemaLibrarySource(value) {
  if (typeof value !== "string") return false;
  return runtimeSchemaLibrarySources.some(
    (source) => value === source || value.startsWith(`${source}/`)
  );
}

// A declaration file installed from a runtime-schema package, e.g.
// `node_modules/.pnpm/zod@4/node_modules/zod/v4/classic/schemas.d.ts`.
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

// True when the expression is built from a runtime-schema library binding
// through local const aliases, member reads, and calls.
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
