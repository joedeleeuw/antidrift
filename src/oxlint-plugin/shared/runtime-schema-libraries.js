import { findVariable } from "./scope.js";
import { unwrapExpression } from "./test-files.js";

const runtimeSchemaLibrarySources = [
  "@effect/schema",
  "@sinclair/typebox",
  "arktype",
  "convex/values",
  "effect",
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

export function isRuntimeSchemaLibrarySource(specifier) {
  if (typeof specifier !== "string") return false;
  return runtimeSchemaLibrarySources.some(
    (source) => specifier === source || specifier.startsWith(`${source}/`)
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

export function isObjectSchemaMethod(method) {
  return method === "object" || method === "Object" || method === "Struct";
}

function isUnionSchemaMethod(method) {
  return (
    method === "union" || method === "Union" || method === "discriminatedUnion"
  );
}

function isLiteralSchemaMethod(method) {
  return method === "literal" || method === "Literal";
}

export function objectSchemaTagPairs(expression, sourceCode, seen = new Set()) {
  const node = unwrapExpression(expression);
  if (node?.type === "Identifier") {
    const definition = findVariable(sourceCode, node)?.defs?.[0];
    if (definition?.parent?.kind !== "const" || seen.has(definition)) return [];
    seen.add(definition);
    return objectSchemaTagPairs(definition.node.init, sourceCode, seen);
  }
  const builder = resolveSchemaBuilderCall(node, sourceCode);
  if (
    !isObjectSchemaMethod(builder?.method) ||
    builder.args[0]?.type !== "ObjectExpression"
  ) {
    return [];
  }
  return builder.args[0].properties.flatMap((property) => {
    const name = staticPropertyName(property);
    if (!schemaDiscriminantKeys.has(name)) return [];
    const literal = resolveSchemaBuilderCall(property.value, sourceCode);
    return isLiteralSchemaMethod(literal?.method) &&
      literal.args[0]?.type === "Literal"
      ? [{ key: name, pair: `${name}:${String(literal.args[0].value)}` }]
      : [];
  });
}

export function unionDiscriminantPairs(
  expression,
  sourceCode,
  memberDeclarators
) {
  const builder = resolveSchemaBuilderCall(
    unwrapExpression(expression),
    sourceCode
  );
  if (!isUnionSchemaMethod(builder?.method)) return [];
  const tagged = builder.method === "discriminatedUnion";
  let variants = [];
  if (tagged && builder.args[1]?.type === "ArrayExpression") {
    variants = builder.args[1].elements;
  } else if (builder.args[0]?.type === "ArrayExpression") {
    variants = builder.args[0].elements;
  } else {
    variants = builder.args;
  }
  if (variants.length < 2) return [];
  for (const variant of variants) {
    const unwrapped = unwrapExpression(variant);
    if (unwrapped?.type === "Identifier") {
      const def = findVariable(sourceCode, unwrapped)?.defs?.[0];
      if (def?.node) memberDeclarators.add(def.node);
    }
  }
  const tagLists = variants.map((variant) =>
    objectSchemaTagPairs(variant, sourceCode)
  );
  const candidates =
    tagged && builder.args[0]?.type === "Literal"
      ? [builder.args[0].value]
      : (tagLists[0] ?? []).map((entry) => entry.key);
  const activeKeys = new Set(
    candidates.filter(
      (key) =>
        schemaDiscriminantKeys.has(key) &&
        tagLists.every((list) => list.some((entry) => entry.key === key))
    )
  );
  return tagLists.flatMap((list) =>
    list.filter((entry) => activeKeys.has(entry.key)).map((entry) => entry.pair)
  );
}

function baseAndExtendedMatch(baseNode, extendedArg, omittedNames, sourceCode) {
  const baseBuilder = resolveSchemaBuilderCall(
    unwrapExpression(baseNode),
    sourceCode
  );
  if (
    !isObjectSchemaMethod(baseBuilder?.method) ||
    baseBuilder.args[0]?.type !== "ObjectExpression" ||
    extendedArg?.type !== "ObjectExpression"
  ) {
    return false;
  }
  const baseTexts = new Map(
    baseBuilder.args[0].properties.flatMap((prop) => {
      const name = staticPropertyName(prop);
      return name ? [[name, sourceCode.getText(prop.value).trim()]] : [];
    })
  );
  const extendedTexts = new Set(
    extendedArg.properties.map((prop) => sourceCode.getText(prop.value).trim())
  );
  return omittedNames.every((name) => {
    const baseText = baseTexts.get(name);
    return baseText !== undefined && extendedTexts.has(baseText);
  });
}

export function isSchemaFieldRename(node, sourceCode) {
  if (
    node.callee?.type !== "MemberExpression" ||
    node.callee.property?.name !== "extend"
  ) {
    return false;
  }
  const chain = resolveSchemaMemberChain(node, sourceCode);
  const extended = chain?.steps.at(-1);
  const omitted = chain?.steps.at(-2);
  if (
    omitted?.method !== "omit" ||
    extended?.node !== node ||
    unwrapExpression(node.callee.object) !== omitted.node
  ) {
    return false;
  }
  const omittedNames = extractObjectFieldNames(omitted.args[0]);
  const extendedNames = extractObjectFieldNames(extended.args[0]);
  if (
    omittedNames.length === 0 ||
    omittedNames.length !== extendedNames.length ||
    !omittedNames.every((name) => !extendedNames.includes(name))
  ) {
    return false;
  }
  const baseNode =
    chain.root?.type === "Identifier"
      ? constInitializer(chain.root, sourceCode)
      : chain.root;
  return baseAndExtendedMatch(
    baseNode,
    extended.args[0],
    omittedNames,
    sourceCode
  );
}
