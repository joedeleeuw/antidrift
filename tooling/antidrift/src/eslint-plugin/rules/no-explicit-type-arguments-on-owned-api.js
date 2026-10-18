import ts from "typescript";

import { defineTypeScriptRule } from "../../semantic-adapters/kernel/rule-kernel.ts";
import { resolveAliasedSymbol } from "../../semantic-adapters/provenance/symbol-provenance.ts";

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
const registrationFactories = new Set([
  "queryOptions",
  "mutationOptions",
  "infiniteQueryOptions",
]);
const swrHookNames = new Set([
  "useSWR",
  "useSWRImmutable",
  "useSWRInfinite",
  "useSWRMutation",
]);

function resolvedCalleeName(checker, tsNameNode) {
  const symbol = resolveAliasedSymbol(
    checker,
    checker.getSymbolAtLocation(tsNameNode)
  );
  return symbol?.getName() ?? null;
}

function calleePackagePath(checker, tsNameNode) {
  const symbol = resolveAliasedSymbol(
    checker,
    checker.getSymbolAtLocation(tsNameNode)
  );
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

function isTrpcProcedureHookCall(checker, tsCall) {
  const callee = tsCall.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  if (!tanstackHookNames.has(callee.name.text)) return false;
  const rest = calleePackagePath(checker, callee.name);
  return rest !== null && rest.startsWith("@trpc/");
}

function isSwrOwnedFetcherCall(checker, tsCall) {
  const callee = tsCall.expression;
  if (!ts.isIdentifier(callee)) return false;
  const name = resolvedCalleeName(checker, callee);
  if (!swrHookNames.has(name) && !swrHookNames.has(callee.text)) return false;
  const rest = calleePackagePath(checker, callee);
  if (rest === null || (rest !== "swr" && !rest.startsWith("swr/"))) {
    return false;
  }
  const fetcherArg = tsCall.arguments[1];
  if (
    !fetcherArg ||
    (!ts.isIdentifier(fetcherArg) && !ts.isPropertyAccessExpression(fetcherArg))
  ) {
    return false;
  }
  const fetcherType = checker.getTypeAtLocation(fetcherArg);
  const signatures = checker.getSignaturesOfType(
    fetcherType,
    ts.SignatureKind.Call
  );
  if (signatures.length === 0) return false;
  return signatures.every((signature) => {
    const returnType = checker.getReturnTypeOfSignature(signature);
    const awaited = checker.getAwaitedType(returnType) ?? returnType;
    return (
      (awaited.flags &
        (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) ===
      0
    );
  });
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

function isGeneratedApiReference(checker, tsNode) {
  if (!tsNode) return false;
  const source = importSourceOfRootIdentifier(checker, tsNode);
  return source !== null && source.endsWith("convex/_generated/api");
}

function isRegistrationFactoryCall(checker, tsNode) {
  if (!tsNode || !ts.isCallExpression(tsNode)) return false;
  const callee = tsNode.expression;
  if (ts.isIdentifier(callee)) {
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
  if (ts.isPropertyAccessExpression(callee)) {
    if (!registrationFactories.has(callee.name.text)) return false;
    const rest = calleePackagePath(checker, callee.name);
    return (
      rest !== null &&
      (rest.startsWith("@trpc/") ||
        rest.startsWith("@orpc/") ||
        rest.startsWith("@tanstack/"))
    );
  }
  return false;
}

function resolvesToRegistration(checker, tsNode, depth = 6) {
  if (!tsNode || depth <= 0) return false;
  if (isRegistrationFactoryCall(checker, tsNode)) return true;
  if (
    ts.isPropertyAccessExpression(tsNode) &&
    tsNode.name.text === "queryKey"
  ) {
    return resolvesToRegistration(checker, tsNode.expression, depth - 1);
  }
  if (ts.isIdentifier(tsNode)) {
    const symbol = resolveAliasedSymbol(
      checker,
      checker.getSymbolAtLocation(tsNode)
    );
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
  return defineTypeScriptRule({
    ruleName: "no-explicit-type-arguments-on-owned-api",
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow caller-supplied result type arguments where a registered API already owns inference (Convex generated function references, TanStack queryOptions/mutationOptions registrations, tRPC procedure hooks, or SWR calls with a typed fetcher). The explicit argument restates or forks the owner.",
      },
      schema: [],
      messages: {
        explicitTypeArgumentOnOwnedApi:
          "This call's result type is owned by its registration (FunctionReturnType of the referenced function, the queryOptions/mutationOptions queryFn, the tRPC procedure, or the typed SWR fetcher). Drop the explicit type argument and infer from the owner; a caller-supplied type can drift from the registration silently.",
      },
    },
    run({ checker, reportNode }) {
      return {
        [ts.SyntaxKind.CallExpression](tsCall) {
          if (!tsCall.typeArguments || tsCall.typeArguments.length === 0) {
            return;
          }
          if (isConvexHookCall(checker, tsCall)) {
            if (isGeneratedApiReference(checker, tsCall.arguments[0])) {
              reportNode(tsCall, {
                messageId: "explicitTypeArgumentOnOwnedApi",
              });
            }
            return;
          }
          if (
            isTrpcProcedureHookCall(checker, tsCall) ||
            isSwrOwnedFetcherCall(checker, tsCall)
          ) {
            reportNode(tsCall, {
              messageId: "explicitTypeArgumentOnOwnedApi",
            });
            return;
          }
          if (!isTanstackCallee(checker, tsCall)) return;
          if (resolvesToRegistration(checker, tsCall.arguments[0])) {
            reportNode(tsCall, {
              messageId: "explicitTypeArgumentOnOwnedApi",
            });
          }
        },
      };
    },
  });
}
