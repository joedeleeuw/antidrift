import { findVariable } from "../../semantic-adapters/async-control-flow.mjs";
import { isRuntimeSchemaLibrarySource } from "../shared/runtime-schema-libraries.js";
import { contextFilename, isTestFilename } from "../shared/test-files.js";

function literalString(node) {
  return node?.type === "Literal" && typeof node.value === "string"
    ? node.value
    : null;
}

function hasValueImport(node) {
  if (node.importKind === "type") return false;
  if (node.specifiers.length === 0) return true;
  return node.specifiers.some(
    (specifier) =>
      specifier.type !== "ImportSpecifier" || specifier.importKind !== "type",
  );
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

export default function ruleNoSchemaLibraryInTest() {
  return {
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow runtime-schema library value imports in test files",
      },
      schema: [],
      messages: {
        schemaLibraryValueImport:
          "Test files must not import runtime-schema libraries as values. Use plain typed fixtures and assert application behavior; type-only imports are allowed.",
      },
    },
    create(context) {
      if (!isTestFilename(contextFilename(context))) return {};
      const sourceCode = context.sourceCode ?? context.getSourceCode();
      return {
        ImportDeclaration(node) {
          if (
            isRuntimeSchemaLibrarySource(literalString(node.source)) &&
            hasValueImport(node)
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
            isRuntimeSchemaLibrarySource(importEqualsSource(node))
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
            isRuntimeSchemaLibrarySource(literalString(node.arguments[0]))
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
