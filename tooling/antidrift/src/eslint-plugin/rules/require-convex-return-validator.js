import ts from "typescript";

import {
  missingTypeServicesVisitors,
  requireTypeServices,
} from "./type-services.js";

const convexRegistrars = new Set([
  "query",
  "mutation",
  "action",
  "internalQuery",
  "internalMutation",
  "internalAction",
]);

function resolvedSymbol(checker, symbol) {
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
    return checker.getAliasedSymbol(symbol);
  }
  return symbol;
}

function symbolDeclaresInConvexServer(symbol) {
  for (const declaration of symbol?.declarations ?? []) {
    const file = declaration.getSourceFile().fileName.replace(/\\/gu, "/");
    const index = file.lastIndexOf("/node_modules/");
    if (index === -1) continue;
    const rest = file.slice(index + "/node_modules/".length);
    if (rest.startsWith("convex/") && rest.includes("/server")) return true;
  }
  return false;
}

function isConvexRegistrarCall(checker, tsCall) {
  const callee = tsCall.expression;
  if (!ts.isIdentifier(callee)) return false;
  const symbol = resolvedSymbol(checker, checker.getSymbolAtLocation(callee));
  if (!symbol || !convexRegistrars.has(symbol.getName())) return false;
  if (symbolDeclaresInConvexServer(symbol)) return true;
  const calleeType = checker.getTypeOfSymbolAtLocation(symbol, callee);
  const typeSymbol = calleeType.aliasSymbol ?? calleeType.getSymbol();
  return symbolDeclaresInConvexServer(typeSymbol);
}

function staticReturnsProperty(objectExpression) {
  let hasStaticReturns = false;
  let hasUnprovableProperty = false;
  for (const property of objectExpression.properties) {
    if (property.type === "SpreadElement" || property.computed) {
      hasUnprovableProperty = true;
      continue;
    }
    if (property.type !== "Property") continue;
    const key = property.key;
    if (
      (key.type === "Identifier" && key.name === "returns") ||
      (key.type === "Literal" && key.value === "returns")
    ) {
      hasStaticReturns = true;
    }
  }
  return { hasStaticReturns, hasUnprovableProperty };
}

export function ruleRequireConvexReturnValidator() {
  return {
    meta: {
      type: "problem",
      docs: {
        description:
          "Require an explicit returns validator on every registered Convex function (query, mutation, action, and their internal counterparts). The validator completes the chain validator → runtime contract → generated function type → inferred consumer.",
      },
      schema: [],
      messages: {
        missingReturnValidator:
          "Registered Convex function is missing a returns validator. The returns validator completes the chain validator → runtime contract → generated function type → inferred consumer; without it the generated function type is inferred from the handler implementation, so consumers inherit whatever the handler happens to return.",
      },
    },
    create(context) {
      const services = requireTypeServices(context);
      if (!services) {
        return missingTypeServicesVisitors(
          context,
          "require-convex-return-validator",
        );
      }
      const checker = services.program.getTypeChecker();
      return {
        CallExpression(node) {
          const firstArgument = node.arguments[0];
          if (!firstArgument || firstArgument.type !== "ObjectExpression") {
            return;
          }
          const tsCall = services.esTreeNodeToTSNodeMap.get(node);
          if (!tsCall || !ts.isCallExpression(tsCall)) return;
          if (!isConvexRegistrarCall(checker, tsCall)) return;
          const { hasStaticReturns, hasUnprovableProperty } =
            staticReturnsProperty(firstArgument);
          if (hasStaticReturns || hasUnprovableProperty) return;
          context.report({ node, messageId: "missingReturnValidator" });
        },
      };
    },
  };
}
