import ts from "typescript";

import {
  missingTypeServicesVisitors,
  requireTypeServices,
} from "./type-services.js";

const convexHookNames = new Set([
  "useQuery",
  "useMutation",
  "useAction",
  "usePaginatedQuery",
]);
const tanstackHookNames = new Set([
  "useQuery",
  "useMutation",
  "useSuspenseQuery",
  "useInfiniteQuery",
]);
const tanstackClientMethods = new Set([
  "getQueryData",
  "setQueryData",
  "fetchQuery",
  "prefetchQuery",
  "ensureQueryData",
]);
const registrationFactories = new Set(["queryOptions", "mutationOptions"]);

function resolvedSymbol(checker, symbol) {
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
    return checker.getAliasedSymbol(symbol);
  }
  return symbol;
}

function resolvedCalleeName(checker, tsNameNode) {
  const symbol = resolvedSymbol(checker, checker.getSymbolAtLocation(tsNameNode));
  return symbol?.getName() ?? null;
}

function calleePackagePath(checker, tsNameNode) {
  const symbol = resolvedSymbol(checker, checker.getSymbolAtLocation(tsNameNode));
  for (const declaration of symbol?.declarations ?? []) {
    const file = declaration.getSourceFile().fileName.replace(/\\/gu, "/");
    const index = file.lastIndexOf("/node_modules/");
    if (index !== -1) return file.slice(index + "/node_modules/".length);
  }
  return null;
}

function isConvexHookCall(checker, tsCall) {
  const callee = tsCall.expression;
  if (!ts.isIdentifier(callee)) return false;
  if (!convexHookNames.has(resolvedCalleeName(checker, callee))) return false;
  const rest = calleePackagePath(checker, callee);
  return (
    rest !== null &&
    (rest === "convex" || rest.startsWith("convex/")) &&
    rest.includes("/react")
  );
}

function isTanstackCallee(checker, tsCall) {
  const callee = tsCall.expression;
  if (ts.isIdentifier(callee)) {
    if (!tanstackHookNames.has(resolvedCalleeName(checker, callee))) {
      return false;
    }
    const rest = calleePackagePath(checker, callee);
    return rest !== null && rest.startsWith("@tanstack/react-query");
  }
  if (ts.isPropertyAccessExpression(callee)) {
    if (!tanstackClientMethods.has(callee.name.text)) return false;
    const rest = calleePackagePath(checker, callee.name);
    return (
      rest !== null &&
      (rest.startsWith("@tanstack/react-query") ||
        rest.startsWith("@tanstack/query-core"))
    );
  }
  return false;
}

function importSourceOfRootIdentifier(checker, tsExpression) {
  let current = tsExpression;
  while (ts.isPropertyAccessExpression(current)) {
    current = current.expression;
  }
  if (!ts.isIdentifier(current)) return null;
  const symbol = checker.getSymbolAtLocation(current);
  for (const declaration of symbol?.declarations ?? []) {
    if (ts.isImportSpecifier(declaration)) {
      const moduleSpecifier = declaration.parent.parent.parent.moduleSpecifier;
      if (ts.isStringLiteral(moduleSpecifier)) return moduleSpecifier.text;
    }
    if (ts.isNamespaceImport(declaration)) {
      const moduleSpecifier = declaration.parent.parent.moduleSpecifier;
      if (ts.isStringLiteral(moduleSpecifier)) return moduleSpecifier.text;
    }
    if (ts.isImportClause(declaration)) {
      const moduleSpecifier = declaration.parent.moduleSpecifier;
      if (ts.isStringLiteral(moduleSpecifier)) return moduleSpecifier.text;
    }
  }
  return null;
}

function isGeneratedApiReference(checker, services, estreeNode) {
  if (!estreeNode) return false;
  const tsNode = services.esTreeNodeToTSNodeMap.get(estreeNode);
  if (!tsNode) return false;
  const source = importSourceOfRootIdentifier(checker, tsNode);
  return source !== null && source.endsWith("convex/_generated/api");
}

function isRegistrationFactoryCall(checker, tsNode) {
  if (!tsNode || !ts.isCallExpression(tsNode)) return false;
  const callee = tsNode.expression;
  if (!ts.isIdentifier(callee)) return false;
  if (!registrationFactories.has(resolvedCalleeName(checker, callee))) {
    return false;
  }
  const rest = calleePackagePath(checker, callee);
  return (
    rest !== null &&
    (rest.startsWith("@tanstack/react-query") ||
      rest.startsWith("@tanstack/query-core"))
  );
}

function resolvesToRegistration(checker, services, estreeNode, depth = 6) {
  if (!estreeNode || depth <= 0) return false;
  const tsNode = services.esTreeNodeToTSNodeMap.get(estreeNode);
  if (!tsNode) return false;
  if (isRegistrationFactoryCall(checker, tsNode)) return true;
  if (ts.isPropertyAccessExpression(tsNode) && tsNode.name.text === "queryKey") {
    return resolvesToRegistration(
      checker,
      services,
      services.tsNodeToESTreeNodeMap.get(tsNode.expression),
      depth - 1,
    );
  }
  if (ts.isIdentifier(tsNode)) {
    const symbol = resolvedSymbol(checker, checker.getSymbolAtLocation(tsNode));
    for (const declaration of symbol?.declarations ?? []) {
      if (
        declaration.initializer &&
        isRegistrationFactoryCall(checker, declaration.initializer)
      ) {
        return true;
      }
    }
  }
  return false;
}

export function ruleNoExplicitTypeArgumentsOnOwnedApi() {
  return {
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow caller-supplied result type arguments where a registered API already owns inference (Convex generated function references, TanStack queryOptions/mutationOptions registrations). The explicit argument restates or forks the owner.",
      },
      schema: [],
      messages: {
        explicitTypeArgumentOnOwnedApi:
          "This call's result type is owned by its registration (FunctionReturnType of the referenced function, or the queryOptions/mutationOptions queryFn). Drop the explicit type argument and infer from the owner; a caller-supplied type can drift from the registration silently.",
      },
    },
    create(context) {
      const services = requireTypeServices(context);
      if (!services) {
        return missingTypeServicesVisitors(
          context,
          "no-explicit-type-arguments-on-owned-api",
        );
      }
      const checker = services.program.getTypeChecker();
      return {
        CallExpression(node) {
          if (!node.typeArguments || node.typeArguments.params.length === 0) {
            return;
          }
          const tsCall = services.esTreeNodeToTSNodeMap.get(node);
          if (!tsCall || !ts.isCallExpression(tsCall)) return;
          if (isConvexHookCall(checker, tsCall)) {
            if (isGeneratedApiReference(checker, services, node.arguments[0])) {
              context.report({
                node,
                messageId: "explicitTypeArgumentOnOwnedApi",
              });
            }
            return;
          }
          if (!isTanstackCallee(checker, tsCall)) return;
          if (resolvesToRegistration(checker, services, node.arguments[0])) {
            context.report({
              node,
              messageId: "explicitTypeArgumentOnOwnedApi",
            });
          }
        },
      };
    },
  };
}
