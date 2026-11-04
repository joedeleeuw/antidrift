import {
  constInitializer,
  findVariable,
  staticPropertyKey,
  unwrapAwaitedExpression,
} from "./scope.js";
import { hasTypeChecker, resolvedDeclarationFiles } from "./type-services.js";

const runtimeSchemaPackages = [
  "@effect/schema",
  "@sinclair/typebox",
  "arktype",
  "convex/values",
  "superstruct",
  "valibot",
  "yup",
  "zod",
];
const effectSchemaModules = new Set(["Schema", "ParseResult"]);
const declarationFileSuffix = /\.d\.[cm]?ts$/u;
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

function isRuntimeSchemaLibrarySource(specifier, importedName = null) {
  if (typeof specifier !== "string") return false;
  if (specifier === "effect") return effectSchemaModules.has(importedName);
  if (specifier.startsWith("effect/")) {
    return effectSchemaModules.has(specifier.slice("effect/".length));
  }
  return runtimeSchemaPackages.some(
    (source) => specifier === source || specifier.startsWith(`${source}/`)
  );
}

function isRuntimeSchemaLibraryFile(fileName) {
  const normalized = fileName.replaceAll("\\", "/");
  const marker = "/node_modules/";
  const index = normalized.lastIndexOf(marker);
  if (index === -1) return false;
  const packagePath = normalized.slice(index + marker.length);
  if (packagePath.startsWith("effect/")) {
    const moduleName = packagePath
      .slice(packagePath.lastIndexOf("/") + 1)
      .replace(declarationFileSuffix, "");
    return effectSchemaModules.has(moduleName);
  }
  return isRuntimeSchemaLibrarySource(packagePath);
}

function importedSchemaLibrary(identifier, sourceCode) {
  const definition = findVariable(sourceCode, identifier)?.defs?.[0];
  if (
    definition?.type !== "ImportBinding" ||
    definition.parent?.type !== "ImportDeclaration"
  ) {
    return false;
  }
  const imported = definition.node?.imported;
  const importedName =
    imported?.type === "Identifier" ? imported.name : (imported?.value ?? null);
  return (
    (typeof importedName === "string" && importedName.endsWith("Schema")) ||
    isRuntimeSchemaLibrarySource(definition.parent.source?.value, importedName)
  );
}

function hasTypedSchemaDeclaration(node, sourceCode) {
  return resolvedDeclarationFiles(node, sourceCode).some(
    isRuntimeSchemaLibraryFile
  );
}

export function hasRuntimeSchemaProvenance(
  expression,
  sourceCode,
  depth = 0,
  seen = new Set()
) {
  if (depth > provenanceDepthLimit) return false;
  const node = unwrapAwaitedExpression(expression);
  if (!node || seen.has(node)) return false;
  seen.add(node);
  if (hasTypedSchemaDeclaration(node, sourceCode)) return true;
  if (node.type === "Identifier") {
    if (importedSchemaLibrary(node, sourceCode)) return true;
    const initializer = constInitializer(sourceCode, node);
    return initializer
      ? hasRuntimeSchemaProvenance(initializer, sourceCode, depth + 1, seen)
      : false;
  }
  if (node.type === "MemberExpression") {
    return hasRuntimeSchemaProvenance(node.object, sourceCode, depth + 1, seen);
  }
  if (node.type === "CallExpression" || node.type === "NewExpression") {
    const callee = unwrapAwaitedExpression(node.callee);
    return hasRuntimeSchemaProvenance(
      callee?.type === "MemberExpression" ? callee.object : callee,
      sourceCode,
      depth + 1,
      seen
    );
  }
  return false;
}

export function schemaReceiverVerdict(expression, sourceCode) {
  if (hasRuntimeSchemaProvenance(expression, sourceCode)) return "proven";
  return hasTypeChecker(sourceCode) ? "disproven" : "unknown";
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
  let root = unwrapAwaitedExpression(node);
  while (root?.type === "CallExpression" || root?.type === "MemberExpression") {
    if (root.type === "MemberExpression") {
      root = unwrapAwaitedExpression(root.object);
      continue;
    }
    const builder = resolveSchemaBuilderCall(root, sourceCode);
    if (!builder) return null;
    steps.unshift({ ...builder, node: root });
    root = unwrapAwaitedExpression(
      root.callee.type === "MemberExpression" ? root.callee.object : root.callee
    );
  }
  return steps.length > 0 ? { root, steps } : null;
}

function objectFieldNames(objectExpression) {
  if (objectExpression?.type !== "ObjectExpression") return [];
  return objectExpression.properties
    .map(staticPropertyKey)
    .filter((name) => name !== null);
}

export function isObjectSchemaMethod(method) {
  return (
    method === "object" ||
    method === "Object" ||
    method === "Struct" ||
    method === "strictObject" ||
    method === "looseObject"
  );
}

function isUnionSchemaMethod(method) {
  return (
    method === "union" ||
    method === "Union" ||
    method === "discriminatedUnion" ||
    method === "variant" ||
    method === "variants" ||
    method === "or"
  );
}

function isLiteralSchemaMethod(method) {
  return method === "literal" || method === "Literal";
}

const openEndedSchemaMethods = new Set([
  "json",
  "unknown",
  "Unknown",
  "any",
  "Any",
  "record",
  "Record",
]);

export function isSchemaUnionCall(expression, sourceCode) {
  const builder = resolveSchemaBuilderCall(
    unwrapAwaitedExpression(expression),
    sourceCode
  );
  if (!isUnionSchemaMethod(builder?.method)) return null;
  const tagged =
    builder.method === "discriminatedUnion" || builder.method === "variant";
  if (tagged && builder.args[1]?.type === "ArrayExpression") {
    const discriminantKey =
      builder.args[0]?.type === "Literal" &&
      typeof builder.args[0].value === "string"
        ? builder.args[0].value
        : null;
    return {
      method: builder.method,
      discriminantKey,
      branches: builder.args[1].elements.filter(Boolean),
    };
  }
  const branches =
    builder.args[0]?.type === "ArrayExpression"
      ? builder.args[0].elements.filter(Boolean)
      : builder.args.filter(Boolean);
  return {
    method: builder.method,
    discriminantKey: null,
    branches,
  };
}

function resolveShapeObjectExpression(argNode, sourceCode) {
  const unwrapped = unwrapAwaitedExpression(argNode);
  if (unwrapped?.type === "ObjectExpression") return unwrapped;
  if (unwrapped?.type === "Identifier") {
    const init = unwrapAwaitedExpression(
      constInitializer(sourceCode, unwrapped)
    );
    if (init?.type === "ObjectExpression") return init;
  }
  return null;
}

export function isSchemaObjectOrExtendCall(expression, sourceCode) {
  const node = unwrapAwaitedExpression(expression);
  const builder = resolveSchemaBuilderCall(node, sourceCode);
  if (!builder) return null;
  const shapeNode = resolveShapeObjectExpression(builder.args[0], sourceCode);
  if (isObjectSchemaMethod(builder.method) && shapeNode) {
    return {
      method: builder.method,
      shapeNode,
      baseSchemaNode: null,
    };
  }
  if (
    (builder.method === "extend" || builder.method === "merge") &&
    shapeNode &&
    node?.callee?.type === "MemberExpression"
  ) {
    return {
      method: builder.method,
      shapeNode,
      baseSchemaNode: node.callee.object,
    };
  }
  return null;
}

export function isSchemaLiteralCall(expression, sourceCode) {
  const builder = resolveSchemaBuilderCall(
    unwrapAwaitedExpression(expression),
    sourceCode
  );
  if (
    !isLiteralSchemaMethod(builder?.method) ||
    builder.args[0]?.type !== "Literal"
  ) {
    return null;
  }
  return {
    literalValue: builder.args[0].value,
    raw: builder.args[0].raw,
    argNode: builder.args[0],
  };
}

export function isOpenEndedJsonSchema(
  expression,
  sourceCode,
  seen = new Set()
) {
  const node = unwrapAwaitedExpression(expression);
  if (!node || seen.has(node)) return false;
  seen.add(node);
  if (node.type === "Identifier") {
    const initializer = constInitializer(sourceCode, node);
    return initializer
      ? isOpenEndedJsonSchema(initializer, sourceCode, seen)
      : false;
  }
  if (node.type === "MemberExpression" && !node.computed) {
    if (
      openEndedSchemaMethods.has(node.property?.name) &&
      hasRuntimeSchemaProvenance(node, sourceCode)
    ) {
      return true;
    }
    return isOpenEndedJsonSchema(node.object, sourceCode, seen);
  }
  const builder = resolveSchemaBuilderCall(node, sourceCode);
  if (!builder) return false;
  if (openEndedSchemaMethods.has(builder.method)) return true;
  if (
    builder.method === "fromJsonString" &&
    builder.args[0] &&
    isOpenEndedJsonSchema(builder.args[0], sourceCode, seen)
  ) {
    return true;
  }
  return node.callee?.type === "MemberExpression"
    ? isOpenEndedJsonSchema(node.callee.object, sourceCode, seen)
    : false;
}

export function objectSchemaTagPairs(expression, sourceCode, seen = new Set()) {
  const node = unwrapAwaitedExpression(expression);
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
    const name = staticPropertyKey(property);
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
    unwrapAwaitedExpression(expression),
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
    const unwrapped = unwrapAwaitedExpression(variant);
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
    unwrapAwaitedExpression(baseNode),
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
      const name = staticPropertyKey(prop);
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
    unwrapAwaitedExpression(node.callee.object) !== omitted.node
  ) {
    return false;
  }
  const omittedNames = objectFieldNames(omitted.args[0]);
  const extendedNames = objectFieldNames(extended.args[0]);
  if (
    omittedNames.length === 0 ||
    omittedNames.length !== extendedNames.length ||
    !omittedNames.every((name) => !extendedNames.includes(name))
  ) {
    return false;
  }
  const baseNode =
    chain.root?.type === "Identifier"
      ? constInitializer(sourceCode, chain.root)
      : chain.root;
  return baseAndExtendedMatch(
    baseNode,
    extended.args[0],
    omittedNames,
    sourceCode
  );
}

const WIDENING_SCHEMA_METHODS = new Set([
  "optional",
  "nullish",
  "nullable",
  "default",
]);

function unwrapPreprocessSchema(expression, sourceCode) {
  const builder = resolveSchemaBuilderCall(expression, sourceCode);
  return builder?.method === "preprocess" && builder.args[1]
    ? builder.args[1]
    : expression;
}

function propertyWideningStep(validatorNode, sourceCode) {
  const inner = unwrapPreprocessSchema(validatorNode, sourceCode);
  const chain = resolveSchemaMemberChain(inner, sourceCode);
  const step = chain?.steps.findLast((entry) =>
    WIDENING_SCHEMA_METHODS.has(entry.method)
  );
  return step ? { chain, step } : null;
}

function referencesShapeField(node, fieldName) {
  let cur = node;
  while (cur?.type === "CallExpression" || cur?.type === "MemberExpression") {
    if (
      cur.type === "MemberExpression" &&
      !cur.computed &&
      cur.property?.name === fieldName &&
      cur.object?.type === "MemberExpression" &&
      !cur.object.computed &&
      cur.object.property?.name === "shape"
    ) {
      return true;
    }
    cur = cur.type === "CallExpression" ? cur.callee : cur.object;
  }
  return false;
}

function localBaseFieldStatus(
  baseNode,
  fieldName,
  sourceCode,
  seen = new Set()
) {
  const unwrapped = unwrapAwaitedExpression(baseNode);
  if (!unwrapped || seen.has(unwrapped)) return "unknown";
  seen.add(unwrapped);
  if (unwrapped.type === "Identifier") {
    const init = constInitializer(sourceCode, unwrapped);
    return init
      ? localBaseFieldStatus(init, fieldName, sourceCode, seen)
      : "unknown";
  }
  const builder = resolveSchemaBuilderCall(unwrapped, sourceCode);
  if (
    builder?.method === "pick" &&
    objectFieldNames(builder.args[0]).includes(fieldName)
  ) {
    return "required";
  }
  const objCall = isSchemaObjectOrExtendCall(unwrapped, sourceCode);
  if (objCall) {
    const match = objCall.shapeNode.properties.find(
      (prop) => staticPropertyKey(prop) === fieldName
    );
    if (match) {
      return propertyWideningStep(match.value, sourceCode)
        ? "already_widened"
        : "required";
    }
    return objCall.baseSchemaNode
      ? localBaseFieldStatus(
          objCall.baseSchemaNode,
          fieldName,
          sourceCode,
          seen
        )
      : "absent";
  }
  return unwrapped.callee?.type === "MemberExpression"
    ? localBaseFieldStatus(unwrapped.callee.object, fieldName, sourceCode, seen)
    : "unknown";
}

export function findWidenedSchemaField(node, sourceCode) {
  const extendCall = isSchemaObjectOrExtendCall(node, sourceCode);
  if (extendCall?.method !== "extend" || !extendCall.baseSchemaNode) {
    return null;
  }
  const properties = extendCall.shapeNode.properties;
  for (const prop of properties) {
    const name = staticPropertyKey(prop);
    const widening = name && propertyWideningStep(prop.value, sourceCode);
    if (!widening) continue;
    const status = localBaseFieldStatus(
      extendCall.baseSchemaNode,
      name,
      sourceCode
    );
    const isImportedFieldSchemaOverride =
      status === "unknown" &&
      properties.length === 1 &&
      widening.chain.root?.type === "Identifier" &&
      widening.chain.root.name === `${name}Schema`;
    if (
      status === "required" ||
      (status !== "already_widened" &&
        referencesShapeField(widening.step.node, name)) ||
      isImportedFieldSchemaOverride
    ) {
      return { node: prop, fieldName: name, method: widening.step.method };
    }
  }
  return null;
}
