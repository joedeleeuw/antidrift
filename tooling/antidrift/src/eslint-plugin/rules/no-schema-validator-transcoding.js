import ts from "typescript";

import {
  defineTypeScriptRule,
  resolveAliasedSymbol,
} from "../../semantic-adapters/ts-rule-kernel.mjs";

const convexRegistrationNames = new Set([
  "query",
  "mutation",
  "action",
  "internalQuery",
  "internalMutation",
  "internalAction",
]);
const convexRegistrationProperties = new Set(["args", "returns"]);

function symbolPackagePath(symbol) {
  for (const declaration of symbol?.declarations ?? []) {
    const file = declaration.getSourceFile().fileName.replace(/\\/gu, "/");
    const index = file.lastIndexOf("/node_modules/");
    if (index !== -1) return file.slice(index + "/node_modules/".length);
  }
  return null;
}

function packageNameOf(packagePath) {
  const segments = packagePath.split("/");
  return segments[0]?.startsWith("@")
    ? segments.slice(0, 2).join("/")
    : segments[0];
}

function resolvedCalleeSymbol(checker, tsCall) {
  const callee = tsCall.expression;
  if (ts.isPropertyAccessExpression(callee)) {
    return resolveAliasedSymbol(
      checker,
      checker.getSymbolAtLocation(callee.name)
    );
  }
  if (ts.isIdentifier(callee)) {
    return resolveAliasedSymbol(checker, checker.getSymbolAtLocation(callee));
  }
  return null;
}

function isEffectJsonSchemaMakeCall(checker, tsCall) {
  const symbol = resolvedCalleeSymbol(checker, tsCall);
  if (symbol?.getName() !== "make") return false;
  const rest = symbolPackagePath(symbol);
  return (
    rest !== null && rest.startsWith("effect/") && rest.includes("JSONSchema")
  );
}

function isZodToJsonSchemaCall(checker, tsCall) {
  const callee = tsCall.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  if (callee.name.text !== "toJSONSchema") return false;
  const symbol = resolveAliasedSymbol(
    checker,
    checker.getSymbolAtLocation(callee.name)
  );
  const rest = symbolPackagePath(symbol);
  return rest !== null && (rest === "zod" || rest.startsWith("zod/"));
}

function isValibotToJsonSchemaCall(checker, tsCall) {
  const symbol = resolvedCalleeSymbol(checker, tsCall);
  if (symbol?.getName() !== "toJsonSchema") return false;
  const rest = symbolPackagePath(symbol);
  return rest !== null && rest.startsWith("@valibot/to-json-schema");
}

function isJsonSchemaConversionCall(checker, tsCall) {
  return (
    isEffectJsonSchemaMakeCall(checker, tsCall) ||
    isZodToJsonSchemaCall(checker, tsCall) ||
    isValibotToJsonSchemaCall(checker, tsCall)
  );
}

function isConvexRegistrationCall(checker, tsCall) {
  const symbol = resolvedCalleeSymbol(checker, tsCall);
  const name = symbol?.getName() ?? "";
  const bareName = name.endsWith("Generic")
    ? name.slice(0, -"Generic".length)
    : name;
  if (!convexRegistrationNames.has(bareName)) return false;
  const rest = symbolPackagePath(symbol);
  return (
    rest !== null && rest.startsWith("convex/") && rest.includes("/server")
  );
}

function isOpenApiDocumentationCall(checker, tsCall) {
  const rest = symbolPackagePath(resolvedCalleeSymbol(checker, tsCall));
  return rest !== null && packageNameOf(rest).toLowerCase().includes("openapi");
}

function isJsonSchemaConversionResult(checker, tsNode, depth = 4) {
  if (!tsNode || depth <= 0) return false;
  if (ts.isCallExpression(tsNode)) {
    if (isJsonSchemaConversionCall(checker, tsNode)) return true;
    // One converter wrapper is part of the chain: the JSON Schema
    // representation flows through a handwritten or helper converter whose
    // result becomes the registered validator.
    return tsNode.arguments.some((argument) =>
      isJsonSchemaConversionResult(checker, argument, depth - 1)
    );
  }
  if (ts.isIdentifier(tsNode)) {
    const symbol = resolveAliasedSymbol(
      checker,
      checker.getSymbolAtLocation(tsNode)
    );
    for (const declaration of symbol?.declarations ?? []) {
      if (
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer &&
        isJsonSchemaConversionResult(
          checker,
          declaration.initializer,
          depth - 1
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

export function ruleNoSchemaValidatorTranscoding() {
  return defineTypeScriptRule({
    ruleName: "no-schema-validator-transcoding",
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow registering a JSON Schema representation of a Zod or Effect schema as a Convex args/returns validator. The JSON Schema representation documents the schema, but re-deriving a runtime validator from it gives the contract two runtime owners that can drift apart.",
      },
      schema: [],
      messages: {
        schemaValidatorTranscoding:
          "This schema's runtime authority is being re-derived through a second representation: the source schema already owns runtime validation, and registering its JSON Schema as a Convex validator creates a second owner that drifts silently. Keep one runtime owner — register the Convex validator directly (convex/values), or keep the JSON Schema for documentation (OpenAPI) only.",
      },
    },
    run({ checker, reportNode }) {
      return {
        [ts.SyntaxKind.CallExpression](tsCall) {
          if (isOpenApiDocumentationCall(checker, tsCall)) return;
          if (!isConvexRegistrationCall(checker, tsCall)) return;
          const [config] = tsCall.arguments;
          if (!config || !ts.isObjectLiteralExpression(config)) return;
          for (const property of config.properties) {
            if (!ts.isPropertyAssignment(property)) continue;
            const key = ts.isIdentifier(property.name)
              ? property.name.text
              : null;
            if (!convexRegistrationProperties.has(key)) continue;
            if (isJsonSchemaConversionResult(checker, property.initializer)) {
              reportNode(property.initializer, {
                messageId: "schemaValidatorTranscoding",
              });
            }
          }
        },
      };
    },
  });
}
