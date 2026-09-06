import { findVariable } from "../../semantic-adapters/async-control-flow.mjs";
import { isRuntimeSchemaLibrarySource } from "../shared/runtime-schema-libraries.js";
import {
  contextFilename,
  isTestFilename,
  staticPropertyName,
  unwrapExpression,
} from "../shared/test-files.js";

const parserLibrarySources = new Set([
  "js-yaml",
  "node:path",
  "node:querystring",
  "node:url",
  "path",
  "qs",
  "querystring",
  "toml",
  "url",
  "yaml",
]);
const parserGlobalNames = new Set([
  "Date",
  "JSON",
  "YAML",
  "path",
  "querystring",
  "qs",
  "toml",
  "url",
  "yaml",
]);
const directValidatorMethods = new Set([
  "parse",
  "parseAsync",
  "safeParse",
  "safeParseAsync",
]);
const distinctiveValidatorMethods = new Set([
  "decodeUnknown",
  "decodeUnknownPromise",
  "decodeUnknownSync",
  "decodeSync",
]);
const provenanceValidatorMethods = new Set([
  "assert",
  "decode",
  "decodeAsync",
  "validate",
]);
const validatorFunctionNames = new Set([
  ...directValidatorMethods,
  ...distinctiveValidatorMethods,
  ...provenanceValidatorMethods,
]);
const arrayProjectionMethods = new Set([
  "at",
  "every",
  "filter",
  "find",
  "findIndex",
  "flat",
  "flatMap",
  "map",
  "reduce",
  "reduceRight",
  "slice",
  "some",
]);
const functionProjectionNames = new Set(["Boolean", "Number", "String"]);
const arrayStaticProjectionMethods = new Set(["from"]);
const objectProjectionMethods = new Set(["entries", "keys", "values"]);
const jsonProjectionMethods = new Set(["stringify"]);
const newProjectionNames = new Set(["Map", "Set", "WeakMap", "WeakSet"]);
const throwMatchers = new Set([
  "doesNotReject",
  "doesNotThrow",
  "rejects",
  "throws",
  "toThrow",
  "toThrowError",
]);
const resolutionDepthLimit = 12;

function importSourceForIdentifier(identifier, sourceCode) {
  if (identifier?.type !== "Identifier") return null;
  const variable = findVariable(sourceCode, identifier);
  const definition = variable?.defs?.[0];
  if (
    definition?.type !== "ImportBinding" ||
    definition.parent?.type !== "ImportDeclaration"
  ) {
    return null;
  }
  const source = definition.parent.source?.value;
  return typeof source === "string" ? source : null;
}

function importedNameForIdentifier(identifier, sourceCode) {
  if (identifier?.type !== "Identifier") return null;
  const variable = findVariable(sourceCode, identifier);
  const definition = variable?.defs?.[0];
  if (definition?.type !== "ImportBinding") return null;
  const specifier = definition.node;
  if (specifier?.type !== "ImportSpecifier") return null;
  const imported = specifier.imported;
  if (imported?.type === "Identifier") return imported.name;
  return typeof imported?.value === "string" ? imported.value : null;
}

function constInitializer(identifier, sourceCode) {
  if (identifier?.type !== "Identifier") return null;
  const variable = findVariable(sourceCode, identifier);
  const definition = variable?.defs?.[0];
  if (
    definition?.type !== "Variable" ||
    definition.node?.type !== "VariableDeclarator" ||
    definition.parent?.kind !== "const"
  ) {
    return null;
  }
  return definition.node.init ?? null;
}

function rootIdentifier(expression) {
  let current = unwrapExpression(expression);
  while (current?.type === "MemberExpression") {
    current = unwrapExpression(current.object);
  }
  return current?.type === "Identifier" ? current : null;
}

function isKnownParserReceiver(receiver, sourceCode) {
  const root = rootIdentifier(receiver);
  if (!root) return false;
  const source = importSourceForIdentifier(root, sourceCode);
  if (source && parserLibrarySources.has(source)) return true;
  return !source && parserGlobalNames.has(root.name);
}

function hasSchemaProvenance(
  expression,
  sourceCode,
  depth = 0,
  seen = new Set(),
) {
  if (depth > resolutionDepthLimit) return false;
  const node = unwrapExpression(expression);
  if (!node || seen.has(node)) return false;
  seen.add(node);
  if (node.type === "Identifier") {
    const source = importSourceForIdentifier(node, sourceCode);
    if (source && isRuntimeSchemaLibrarySource(source)) return true;
    const initializer = constInitializer(node, sourceCode);
    return initializer
      ? hasSchemaProvenance(initializer, sourceCode, depth + 1, seen)
      : false;
  }
  if (node.type === "MemberExpression") {
    return hasSchemaProvenance(node.object, sourceCode, depth + 1, seen);
  }
  if (node.type === "CallExpression") {
    if (node.callee.type === "MemberExpression") {
      return hasSchemaProvenance(
        node.callee.object,
        sourceCode,
        depth + 1,
        seen,
      );
    }
    return hasSchemaProvenance(node.callee, sourceCode, depth + 1, seen);
  }
  return false;
}

function isValidatorMember(member, sourceCode) {
  const method = staticPropertyName(member);
  if (!method) return false;
  if (directValidatorMethods.has(method)) {
    return !isKnownParserReceiver(member.object, sourceCode);
  }
  if (distinctiveValidatorMethods.has(method)) return true;
  return (
    provenanceValidatorMethods.has(method) &&
    hasSchemaProvenance(member.object, sourceCode)
  );
}

function isValidatorFunctionIdentifier(identifier, sourceCode, depth = 0) {
  if (depth > resolutionDepthLimit || identifier?.type !== "Identifier") {
    return false;
  }
  const source = importSourceForIdentifier(identifier, sourceCode);
  if (source) {
    if (parserLibrarySources.has(source)) return false;
    const importedName = importedNameForIdentifier(identifier, sourceCode);
    return (
      isRuntimeSchemaLibrarySource(source) &&
      importedName !== null &&
      validatorFunctionNames.has(importedName)
    );
  }
  const initializer = unwrapExpression(
    constInitializer(identifier, sourceCode),
  );
  if (!initializer) return false;
  if (initializer.type === "Identifier") {
    return isValidatorFunctionIdentifier(initializer, sourceCode, depth + 1);
  }
  if (initializer.type === "MemberExpression") {
    return isValidatorMember(initializer, sourceCode);
  }
  if (
    initializer.type === "CallExpression" &&
    initializer.callee.type === "MemberExpression" &&
    staticPropertyName(initializer.callee) === "bind"
  ) {
    const callable = unwrapExpression(initializer.callee.object);
    return (
      callable?.type === "MemberExpression" &&
      isValidatorMember(callable, sourceCode)
    );
  }
  return false;
}

function isValidatorInvocation(expression, sourceCode) {
  const node = unwrapExpression(expression);
  if (node?.type !== "CallExpression") return false;
  const callee = unwrapExpression(node.callee);
  if (callee?.type === "MemberExpression") {
    return isValidatorMember(callee, sourceCode);
  }
  if (callee?.type === "Identifier") {
    return isValidatorFunctionIdentifier(callee, sourceCode);
  }
  return (
    callee?.type === "CallExpression" &&
    isValidatorInvocation(callee, sourceCode)
  );
}

function isFunctionProjectionCall(node) {
  const callee = unwrapExpression(node.callee);
  if (callee?.type === "Identifier") {
    return functionProjectionNames.has(callee.name) ? node.arguments[0] : null;
  }
  if (callee?.type !== "MemberExpression") return null;
  const method = staticPropertyName(callee);
  const root = rootIdentifier(callee.object);
  if (
    (root?.name === "Array" && arrayStaticProjectionMethods.has(method)) ||
    (root?.name === "Object" && objectProjectionMethods.has(method))
  ) {
    return node.arguments[0] ?? null;
  }
  if (root?.name === "JSON" && jsonProjectionMethods.has(method)) {
    return node.arguments[0] ?? null;
  }
  if (arrayProjectionMethods.has(method)) return callee.object;
  return null;
}

function validatorOrigin(expression, sourceCode, depth = 0, seen = new Set()) {
  if (depth > resolutionDepthLimit) return null;
  const node = unwrapExpression(expression);
  if (!node || seen.has(node)) return null;
  seen.add(node);
  if (isValidatorInvocation(node, sourceCode)) return node;
  if (node.type === "Identifier") {
    const initializer = constInitializer(node, sourceCode);
    return initializer
      ? validatorOrigin(initializer, sourceCode, depth + 1, seen)
      : null;
  }
  if (node.type === "MemberExpression") {
    return validatorOrigin(node.object, sourceCode, depth + 1, seen);
  }
  if (node.type === "CallExpression") {
    const projected = isFunctionProjectionCall(node);
    return projected
      ? validatorOrigin(projected, sourceCode, depth + 1, seen)
      : null;
  }
  if (
    node.type === "NewExpression" &&
    node.callee.type === "Identifier" &&
    newProjectionNames.has(node.callee.name)
  ) {
    return node.arguments[0]
      ? validatorOrigin(node.arguments[0], sourceCode, depth + 1, seen)
      : null;
  }
  return null;
}

function expectRootCall(expression) {
  const node = unwrapExpression(expression);
  return node?.type === "CallExpression" &&
    node.callee.type === "Identifier" &&
    node.callee.name === "expect"
    ? node
    : null;
}

function parseExpectAssertion(node) {
  if (
    node.type !== "CallExpression" ||
    node.callee.type !== "MemberExpression"
  ) {
    return null;
  }
  const matcher = staticPropertyName(node.callee);
  if (!matcher) return null;
  const modifiers = new Set();
  let current = unwrapExpression(node.callee.object);
  while (current?.type === "MemberExpression") {
    const modifier = staticPropertyName(current);
    if (modifier) modifiers.add(modifier);
    current = unwrapExpression(current.object);
  }
  const expectCall = expectRootCall(current);
  if (!expectCall) return null;
  return {
    node,
    matcher,
    modifiers,
    subject: expectCall.arguments[0]
      ? unwrapExpression(expectCall.arguments[0])
      : null,
  };
}

function parseAssertAssertion(node) {
  if (
    node.type !== "CallExpression" ||
    node.callee.type !== "MemberExpression"
  ) {
    return null;
  }
  const matcher = staticPropertyName(node.callee);
  const root = rootIdentifier(node.callee.object);
  if (!matcher || root?.name !== "assert") return null;
  return {
    node,
    matcher,
    modifiers: new Set(),
    subject: node.arguments[0] ? unwrapExpression(node.arguments[0]) : null,
  };
}

function functionValidatorOrigin(subject, sourceCode) {
  if (
    subject?.type !== "ArrowFunctionExpression" &&
    subject?.type !== "FunctionExpression"
  ) {
    return null;
  }
  if (subject.body.type !== "BlockStatement") {
    return validatorOrigin(subject.body, sourceCode);
  }
  let origin = null;
  for (const statement of subject.body.body) {
    let expression = null;
    if (statement.type === "ExpressionStatement") {
      expression = statement.expression;
    } else if (statement.type === "ReturnStatement") {
      expression = statement.argument;
    } else if (statement.type === "VariableDeclaration") {
      const initializers = statement.declarations
        .map((declaration) => declaration.init)
        .filter(Boolean);
      if (initializers.length === 0) return null;
      for (const initializer of initializers) {
        const candidate = validatorOrigin(initializer, sourceCode);
        if (!candidate) return null;
        origin ??= candidate;
      }
      continue;
    } else {
      return null;
    }
    const candidate = expression
      ? validatorOrigin(expression, sourceCode)
      : null;
    if (!candidate) return null;
    origin ??= candidate;
  }
  return origin;
}

function assertionFinding(record, sourceCode) {
  if (!record.subject) return null;
  if (throwMatchers.has(record.matcher)) {
    return (functionValidatorOrigin(record.subject, sourceCode) ??
      validatorOrigin(record.subject, sourceCode))
      ? "validatorThrowOracle"
      : null;
  }
  const origin = validatorOrigin(record.subject, sourceCode);
  if (!origin) return null;
  return record.modifiers.has("rejects")
    ? "validatorThrowOracle"
    : "validatorOutputOracle";
}

export default function ruleNoValidatorOutputOracle() {
  return {
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow assertions whose oracle is runtime-validator output",
      },
      schema: [],
      messages: {
        validatorOutputOracle:
          "This assertion targets runtime-validator output rather than application behavior. Tip: checking parsed body or payload shapes is often a sign of a low-value test. Assert observable application behavior or remove the test.",
        validatorThrowOracle:
          "This assertion only proves that a runtime validator accepts or rejects input. Tip: checking parsed body or payload shapes is often a sign of a low-value test. Assert observable application behavior or remove the test.",
      },
    },
    create(context) {
      if (!isTestFilename(contextFilename(context))) return {};
      const sourceCode = context.sourceCode ?? context.getSourceCode();
      return {
        CallExpression(node) {
          const record =
            parseExpectAssertion(node) ?? parseAssertAssertion(node);
          if (!record) return;
          const messageId = assertionFinding(record, sourceCode);
          if (messageId) context.report({ node, messageId });
        },
      };
    },
  };
}
