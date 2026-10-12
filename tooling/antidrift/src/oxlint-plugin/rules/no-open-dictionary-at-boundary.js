import { findVariable } from "../../semantic-adapters/async-control-flow.mjs";
import { unwrapExpression } from "../../semantic-adapters/local-ast-rules.mjs";

function isOpenValue(node) {
  return node?.type === "TSUnknownKeyword" || node?.type === "TSAnyKeyword";
}

function isOpenDictionary(node, sourceCode) {
  if (node.type === "TSIndexSignature") {
    return (
      node.parameters.length === 1 &&
      node.parameters[0].typeAnnotation?.typeAnnotation.type ===
        "TSStringKeyword" &&
      isOpenValue(node.typeAnnotation?.typeAnnotation)
    );
  }
  if (
    node.type !== "TSTypeReference" ||
    node.typeName.type !== "Identifier" ||
    node.typeName.name !== "Record"
  ) {
    return false;
  }
  if (findVariable(sourceCode, node.typeName)?.defs.length) return false;
  const parameters = (node.typeArguments ?? node.typeParameters)?.params;
  return (
    parameters?.length === 2 &&
    parameters[0].type === "TSStringKeyword" &&
    isOpenValue(parameters[1])
  );
}

function annotation(node) {
  if (node.type === "AssignmentPattern") return annotation(node.left);
  return node.typeAnnotation;
}

// Type-parameter constraints and defaults bound a caller-chosen type rather
// than erase one, so only parameter and return annotations count.
function signatureTypes(node) {
  return [...node.params.map(annotation), node.returnType].filter(Boolean);
}

const functionTypes = new Set([
  "FunctionDeclaration",
  "TSDeclareFunction",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

function boundaryTypes(node) {
  const boundary = unwrapExpression(node);
  if (functionTypes.has(boundary.type)) return signatureTypes(boundary);
  if (boundary.type !== "VariableDeclarator") return [];
  const types = [boundary.id.typeAnnotation].filter(Boolean);
  const init = unwrapExpression(boundary.init);
  if (
    init?.type === "FunctionExpression" ||
    init?.type === "ArrowFunctionExpression"
  ) {
    types.push(...signatureTypes(init));
  }
  return types;
}

function dictionaryNodes(node, sourceCode) {
  if (isOpenDictionary(node, sourceCode)) return [node];
  return (sourceCode.visitorKeys[node.type] ?? []).flatMap((key) => {
    const children = Array.isArray(node[key]) ? node[key] : [node[key]];
    return children
      .filter(Boolean)
      .flatMap((child) => dictionaryNodes(child, sourceCode));
  });
}

function exportedDeclarations(node, sourceCode) {
  const declaration = node.declaration;
  if (declaration?.type === "VariableDeclaration") {
    return declaration.declarations.flatMap((entry) =>
      sourceCode
        .getDeclaredVariables(entry)
        .map((variable) => ({ node: entry, name: variable.name }))
    );
  }
  if (declaration && declaration.type !== "Identifier") {
    return [{ node: declaration, name: declaration.id?.name ?? "default" }];
  }
  const references = declaration
    ? [{ local: declaration, exported: { name: "default" } }]
    : node.specifiers;
  if (node.source || node.exportKind === "type") return [];
  return references.flatMap((specifier) => {
    if (
      specifier.type === "ExportAllDeclaration" ||
      specifier.exportKind === "type"
    ) {
      return [];
    }
    const variable = findVariable(sourceCode, specifier.local);
    return (variable?.defs ?? [])
      .filter((definition) =>
        ["Variable", "FunctionName"].includes(definition.type)
      )
      .map((definition) => ({
        node: definition.node,
        name: specifier.exported.name ?? specifier.exported.value,
      }));
  });
}

export default function ruleNoOpenDictionaryAtBoundary() {
  return {
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow open any/unknown dictionaries in exported signatures and variable annotations.",
      },
      schema: [
        {
          type: "object",
          properties: {
            allows: {
              type: "array",
              items: { type: "string" },
              uniqueItems: true,
            },
          },
          additionalProperties: false,
        },
      ],
      messages: {
        openBoundary:
          "Open dictionary at the module boundary erases the owned type; name the owner type instead.",
      },
    },
    create(context) {
      const allows = new Set(context.options[0]?.allows ?? []);
      const reported = new Set();
      function check(node) {
        for (const entry of exportedDeclarations(node, context.sourceCode)) {
          if (allows.has(entry.name)) continue;
          for (const type of boundaryTypes(entry.node)) {
            for (const dictionary of dictionaryNodes(
              type,
              context.sourceCode
            )) {
              if (reported.has(dictionary)) continue;
              reported.add(dictionary);
              context.report({ node: dictionary, messageId: "openBoundary" });
            }
          }
        }
      }
      return { ExportNamedDeclaration: check, ExportDefaultDeclaration: check };
    },
  };
}
