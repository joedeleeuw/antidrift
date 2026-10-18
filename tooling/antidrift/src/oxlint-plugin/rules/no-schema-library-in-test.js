import { findVariable } from "../../semantic-adapters/kernel/async-control-flow.ts";
import {
  hasRuntimeSchemaProvenance,
  isRuntimeSchemaLibrarySource,
} from "../shared/runtime-schema-libraries.js";
import {
  contextFilename,
  isTestFilename,
  staticPropertyName,
} from "../shared/test-files.js";

// Schema members and functions that validate, read, or sanitize data. Using
// one makes the schema a test-owned oracle instead of application input.
const schemaOracleNames = new Set([
  "Check",
  "Clean",
  "Create",
  "Decode",
  "Default",
  "Errors",
  "Parse",
  "_def",
  "_zod",
  "assert",
  "cast",
  "create",
  "decode",
  "decodeAsync",
  "decodeSync",
  "decodeUnknown",
  "decodeUnknownPromise",
  "decodeUnknownSync",
  "def",
  "element",
  "encode",
  "encodeSync",
  "is",
  "isValid",
  "isValidSync",
  "keyof",
  "mask",
  "options",
  "parse",
  "parseAsync",
  "safeParse",
  "safeParseAsync",
  "shape",
  "spa",
  "validate",
  "validateAt",
  "validateSync",
  "validateSyncAt",
]);
// Callee roots owned by the test runner or the language, not the application.
const nonApplicationRoots = new Set([
  "Array",
  "BigInt",
  "Boolean",
  "Date",
  "Error",
  "JSON",
  "Map",
  "Math",
  "Number",
  "Object",
  "Promise",
  "Reflect",
  "RegExp",
  "Set",
  "String",
  "Symbol",
  "WeakMap",
  "WeakSet",
  "afterAll",
  "afterEach",
  "assert",
  "beforeAll",
  "beforeEach",
  "chai",
  "console",
  "describe",
  "expect",
  "it",
  "jest",
  "sinon",
  "structuredClone",
  "test",
  "vi",
]);
const expressionWrappers = new Set([
  "ChainExpression",
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
]);
// Parents that carry a schema value onward without consuming it.
const transparentParents = new Set([
  ...expressionWrappers,
  "ArrayExpression",
  "AwaitExpression",
  "LogicalExpression",
  "ObjectExpression",
  "SpreadElement",
]);
const typePositionParents = new Set([
  "TSQualifiedName",
  "TSTypeQuery",
  "TSTypeReference",
]);

function literalString(node) {
  return node?.type === "Literal" && typeof node.value === "string"
    ? node.value
    : null;
}

function memberKeyName(property) {
  if (!property.computed && property.key?.type === "Identifier") {
    return property.key.name;
  }
  return literalString(property.key) ?? "";
}

function importedName(specifier) {
  const imported = specifier.imported;
  if (imported?.type === "Identifier") return imported.name;
  return literalString(imported) ?? "";
}

function isUnshadowedRequire(callee, sourceCode) {
  if (callee?.type !== "Identifier" || callee.name !== "require") return false;
  const variable = findVariable(sourceCode, callee);
  return !variable || variable.defs.length === 0;
}

function importEqualsSource(node) {
  const reference = node.moduleReference;
  if (reference?.type !== "TSExternalModuleReference") return null;
  return literalString(reference.expression);
}

function patternIdentifiers(pattern) {
  switch (pattern?.type) {
    case "Identifier":
      return [pattern];
    case "ObjectPattern":
      return pattern.properties.flatMap((property) =>
        patternIdentifiers(
          property.type === "RestElement" ? property.argument : property.value
        )
      );
    case "ArrayPattern":
      return pattern.elements.flatMap(patternIdentifiers);
    case "AssignmentPattern":
      return patternIdentifiers(pattern.left);
    case "RestElement":
      return patternIdentifiers(pattern.argument);
    default:
      return [];
  }
}

function destructuresOracle(pattern) {
  return (
    pattern.type === "ObjectPattern" &&
    pattern.properties.some(
      (property) =>
        property.type === "Property" &&
        schemaOracleNames.has(memberKeyName(property))
    )
  );
}

function calleeRoot(callee) {
  let current = callee;
  while (current) {
    if (current.type === "MemberExpression") current = current.object;
    else if (current.type === "CallExpression") current = current.callee;
    else if (current.type === "AwaitExpression") current = current.argument;
    else if (expressionWrappers.has(current.type)) current = current.expression;
    else return current;
  }
  return null;
}

function isApplicationCallee(callee) {
  const root = calleeRoot(callee);
  return !(root?.type === "Identifier" && nonApplicationRoots.has(root.name));
}

function isTypePositionReference(identifier) {
  return typePositionParents.has(identifier.parent?.type);
}

function isValueRead(reference) {
  if (reference.isTypeReference === true && !reference.isValueReference) {
    return false;
  }
  if (typeof reference.isRead === "function" && !reference.isRead()) {
    return false;
  }
  return !isTypePositionReference(reference.identifier);
}

// Every read of every binding must reach an application API (a call,
// constructor, or JSX prop) through schema builder steps only. A binding with
// no reads proves nothing and stays reported.
function bindingsFlowIntoApplication(identifiers, sourceCode, seen) {
  return identifiers.every((identifier) => {
    const variable = findVariable(sourceCode, identifier);
    if (!variable) return false;
    if (seen.has(variable)) return true;
    seen.add(variable);
    const reads = variable.references.filter(isValueRead);
    return (
      reads.length > 0 &&
      reads.every((reference) =>
        flowsIntoApplication(reference.identifier, sourceCode, seen)
      )
    );
  });
}

function argumentFlowsIntoApplication(call, sourceCode) {
  if (hasRuntimeSchemaProvenance(call.callee, sourceCode)) return null;
  return isApplicationCallee(call.callee);
}

// `expect(output).toBeInstanceOf(z.ZodObject)` checks the class of what the
// application produced; it builds and reads no data.
function isInstanceMatcherCall(call) {
  return (
    call.callee.type === "MemberExpression" &&
    staticPropertyName(call.callee) === "toBeInstanceOf" &&
    calleeRoot(call.callee)?.name === "expect"
  );
}

const endToEndPath = /(?:^|[/\\.-])e2e[/\\.]/u;

function flowsIntoApplication(start, sourceCode, seen) {
  let current = start;
  for (;;) {
    const parent = current.parent;
    if (!parent) return false;
    if (transparentParents.has(parent.type)) {
      current = parent;
      continue;
    }
    switch (parent.type) {
      case "MemberExpression":
        if (
          parent.object !== current ||
          schemaOracleNames.has(staticPropertyName(parent))
        ) {
          return false;
        }
        break;
      case "CallExpression":
      case "NewExpression":
        if (parent.callee !== current) {
          if (isInstanceMatcherCall(parent)) return true;
          const application = argumentFlowsIntoApplication(parent, sourceCode);
          if (application !== null) return application;
        }
        break;
      case "ConditionalExpression":
        if (parent.test === current) return false;
        break;
      case "Property":
        if (
          parent.value !== current ||
          parent.parent?.type !== "ObjectExpression"
        ) {
          return false;
        }
        current = parent.parent;
        continue;
      case "VariableDeclarator":
        return (
          parent.init === current &&
          !destructuresOracle(parent.id) &&
          bindingsFlowIntoApplication(
            patternIdentifiers(parent.id),
            sourceCode,
            seen
          )
        );
      case "JSXExpressionContainer":
        return parent.parent?.type === "JSXAttribute";
      case "BinaryExpression":
        return parent.operator === "instanceof" && parent.right === current;
      default:
        return false;
    }
    current = parent;
  }
}

function importedBindings(node) {
  return node.specifiers.filter(
    (specifier) =>
      specifier.type !== "ImportSpecifier" || specifier.importKind !== "type"
  );
}

function importFlowsIntoApplication(node, sourceCode) {
  const specifiers = importedBindings(node);
  return (
    specifiers.length > 0 &&
    specifiers.every(
      (specifier) =>
        specifier.type !== "ImportSpecifier" ||
        !schemaOracleNames.has(importedName(specifier))
    ) &&
    bindingsFlowIntoApplication(
      specifiers.map((specifier) => specifier.local),
      sourceCode,
      new Set()
    )
  );
}

export default function ruleNoSchemaLibraryInTest() {
  return {
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow test-owned runtime-schema validation, reads, or sanitizing in test files",
      },
      schema: [],
      messages: {
        schemaLibraryValueImport:
          "Test files must not use runtime-schema libraries to build, validate, read, or sanitize test data. Use plain typed fixtures and assert application behavior; type-only imports and schema values passed straight into application APIs are allowed.",
      },
    },
    create(context) {
      const filename = contextFilename(context);
      // End-to-end smokes decode real responses at the boundary they cross.
      if (!isTestFilename(filename) || endToEndPath.test(filename)) return {};
      const sourceCode = context.sourceCode ?? context.getSourceCode();
      return {
        ImportDeclaration(node) {
          if (
            node.importKind !== "type" &&
            isRuntimeSchemaLibrarySource(literalString(node.source)) &&
            (node.specifiers.length === 0 ||
              importedBindings(node).length > 0) &&
            !importFlowsIntoApplication(node, sourceCode)
          ) {
            context.report({
              node,
              messageId: "schemaLibraryValueImport",
            });
          }
        },
        ImportExpression(node) {
          if (isRuntimeSchemaLibrarySource(literalString(node.source))) {
            context.report({
              node,
              messageId: "schemaLibraryValueImport",
            });
          }
        },
        TSImportEqualsDeclaration(node) {
          if (
            node.importKind !== "type" &&
            isRuntimeSchemaLibrarySource(importEqualsSource(node)) &&
            !bindingsFlowIntoApplication([node.id], sourceCode, new Set())
          ) {
            context.report({
              node,
              messageId: "schemaLibraryValueImport",
            });
          }
        },
        CallExpression(node) {
          if (
            isUnshadowedRequire(node.callee, sourceCode) &&
            isRuntimeSchemaLibrarySource(literalString(node.arguments[0])) &&
            !flowsIntoApplication(node, sourceCode, new Set())
          ) {
            context.report({
              node,
              messageId: "schemaLibraryValueImport",
            });
          }
        },
      };
    },
  };
}
