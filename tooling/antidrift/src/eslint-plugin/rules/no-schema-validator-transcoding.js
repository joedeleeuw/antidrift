import ts from "typescript";

import {
  missingTypeServicesVisitors,
  requireTypeServices,
} from "./type-services.js";

const convexRegistrationNames = new Set([
  "query",
  "mutation",
  "action",
  "internalQuery",
  "internalMutation",
  "internalAction",
]);
const convexRegistrationProperties = new Set(["args", "returns"]);

function resolvedSymbol(checker, symbol) {
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
    return checker.getAliasedSymbol(symbol);
  }
  return symbol;
}

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
    return resolvedSymbol(checker, checker.getSymbolAtLocation(callee.name));
  }
  if (ts.isIdentifier(callee)) {
    return resolvedSymbol(checker, checker.getSymbolAtLocation(callee));
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
  const symbol = resolvedSymbol(checker, checker.getSymbolAtLocation(callee.name));
  const rest = symbolPackagePath(symbol);
  return rest !== null && (rest === "zod" || rest.startsWith("zod/"));
}

function isJsonSchemaConversionCall(checker, tsCall) {
  return (
    isEffectJsonSchemaMakeCall(checker, tsCall) ||
    isZodToJsonSchemaCall(checker, tsCall)
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
  return (
    rest !== null && packageNameOf(rest).toLowerCase().includes("openapi")
  );
}

function isJsonSchemaConversionResult(checker, services, estreeNode, depth = 4) {
  if (!estreeNode || depth <= 0) return false;
  const tsNode = services.esTreeNodeToTSNodeMap.get(estreeNode);
  if (!tsNode) return false;
  if (ts.isCallExpression(tsNode)) {
    if (isJsonSchemaConversionCall(checker, tsNode)) return true;
    // One converter wrapper is part of the chain: the JSON Schema
    // representation flows through a handwritten or helper converter whose
    // result becomes the registered validator.
    return tsNode.arguments.some((argument) =>
      isJsonSchemaConversionResult(
        checker,
        services,
        services.tsNodeToESTreeNodeMap.get(argument),
        depth - 1,
      ),
    );
  }
  if (ts.isIdentifier(tsNode)) {
    const symbol = resolvedSymbol(checker, checker.getSymbolAtLocation(tsNode));
    for (const declaration of symbol?.declarations ?? []) {
      if (
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer &&
        isJsonSchemaConversionResult(
          checker,
          services,
          services.tsNodeToESTreeNodeMap.get(declaration.initializer),
          depth - 1,
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

export function ruleNoSchemaValidatorTranscoding() {
  return {
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
    create(context) {
      const services = requireTypeServices(context);
      if (!services) {
        return missingTypeServicesVisitors(
          context,
          "no-schema-validator-transcoding",
        );
      }
      const checker = services.program.getTypeChecker();
      return {
        CallExpression(node) {
          const tsCall = services.esTreeNodeToTSNodeMap.get(node);
          if (!tsCall || !ts.isCallExpression(tsCall)) return;
          if (isOpenApiDocumentationCall(checker, tsCall)) return;
          if (!isConvexRegistrationCall(checker, tsCall)) return;
          const [config] = node.arguments;
          if (!config || config.type !== "ObjectExpression") return;
          for (const property of config.properties) {
            if (property.type !== "Property" || property.computed) continue;
            const key =
              property.key.type === "Identifier" ? property.key.name : null;
            if (!convexRegistrationProperties.has(key)) continue;
            if (isJsonSchemaConversionResult(checker, services, property.value)) {
              context.report({
                node: property.value,
                messageId: "schemaValidatorTranscoding",
              });
            }
          }
        },
      };
    },
  };
}
