import { isRuleFile, scopeProperties } from "./scope.js";
import { getPropertyName, isAstNode, unwrapExpression } from "./ast.js";

const CACHE_METHODS = new Set([
  "invalidateQueries",
  "setQueryData",
  "removeQueries",
  "cancelQueries",
]);
const POSITIONAL_KEY_METHODS = new Set(["setQueryData"]);
const calleeMethodName = (callee) => {
  const unwrapped = unwrapExpression(callee);
  if (
    !unwrapped ||
    unwrapped.type !== "MemberExpression" ||
    unwrapped.computed !== false
  ) {
    return null;
  }
  return getPropertyName(unwrapped.property);
};
const MODULE_SCOPES = new Set(["global", "module"]);
const constInitializer = (identifier, context) => {
  let scope = context.sourceCode.getScope(identifier);
  while (scope) {
    const variable = scope.set.get(identifier.name);
    if (variable) {
      if (MODULE_SCOPES.has(scope.type) || variable.defs.length !== 1) {
        return null;
      }
      const definition = variable.defs.at(0);
      if (
        !isAstNode(definition?.node) ||
        definition.node.type !== "VariableDeclarator" ||
        definition.parent?.kind !== "const"
      ) {
        return null;
      }
      return unwrapExpression(definition.node.init) ?? null;
    }
    scope = scope.upper;
  }
  return null;
};
const literalOf = (node, expected, context) => {
  const unwrapped = unwrapExpression(node);
  if (!unwrapped) {
    return null;
  }
  if (unwrapped.type === expected) {
    return unwrapped;
  }
  if (unwrapped.type !== "Identifier") {
    return null;
  }
  const initializer = constInitializer(unwrapped, context);
  return initializer?.type === expected ? initializer : null;
};
const isQueryKeyReference = (node) => {
  const unwrapped = unwrapExpression(node);
  if (!unwrapped) {
    return false;
  }
  if (unwrapped.type === "Identifier") {
    return unwrapped.name === "queryKey";
  }
  if (unwrapped.type === "MemberExpression" && unwrapped.computed === false) {
    return getPropertyName(unwrapped.property) === "queryKey";
  }
  return false;
};
const isNumericLiteral = (node) => {
  const unwrapped = unwrapExpression(node);
  if (!unwrapped) {
    return false;
  }
  if (unwrapped.type === "Literal") {
    return typeof unwrapped.value === "number";
  }
  return (
    unwrapped.type === "UnaryExpression" &&
    unwrapped.operator === "-" &&
    isNumericLiteral(unwrapped.argument)
  );
};
const isKeyPositionRead = (node) => {
  const unwrapped = unwrapExpression(node);
  if (!unwrapped) {
    return false;
  }
  if (unwrapped.type === "CallExpression") {
    const callee = unwrapExpression(unwrapped.callee);
    if (
      !callee ||
      callee.type !== "MemberExpression" ||
      callee.computed !== false ||
      getPropertyName(callee.property) !== "at"
    ) {
      return false;
    }
    const args = Array.isArray(unwrapped.arguments) ? unwrapped.arguments : [];
    return (
      args.length === 1 &&
      isNumericLiteral(args.at(0)) &&
      isQueryKeyReference(callee.object)
    );
  }
  if (unwrapped.type === "MemberExpression" && unwrapped.computed === true) {
    return (
      isNumericLiteral(unwrapped.property) &&
      isQueryKeyReference(unwrapped.object)
    );
  }
  return false;
};
const isInsidePredicateOption = (node) => {
  let current = node.parent;
  while (isAstNode(current)) {
    if (
      current.type === "Property" &&
      getPropertyName(current.key) === "predicate"
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
};
export default {
  meta: {
    schema: [
      {
        type: "object",
        properties: scopeProperties,
        additionalProperties: false,
      },
    ],

    type: "problem",
    messages: {
      inlineQueryKey:
        "Pass a query-key factory call here, not an inline array. A " +
        "hand-typed key silently stops matching when the factory's shape " +
        "changes (QueryKey is unknown[]), leaving the cache stale.",
      inlinePredicate:
        "Match the key with a named helper exported next to the factory " +
        "(for example `matchesChatThread(query.queryKey, threadRef)`), " +
        "not with inline key-position comparisons that restate the " +
        "factory's layout where nothing checks it.",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};

    return {
      CallExpression(node) {
        const method = calleeMethodName(node.callee);
        if (method === null || !CACHE_METHODS.has(method)) {
          return;
        }
        const args = Array.isArray(node.arguments) ? node.arguments : [];
        if (POSITIONAL_KEY_METHODS.has(method)) {
          const positionalKey = literalOf(
            args.at(0),
            "ArrayExpression",
            context,
          );
          if (positionalKey && args.at(0)?.type !== "Identifier") {
            context.report({
              node: positionalKey,
              messageId: "inlineQueryKey",
            });
          }
        }
        for (const argument of args) {
          const options = literalOf(argument, "ObjectExpression", context);
          if (!options) {
            continue;
          }
          const properties = Array.isArray(options.properties)
            ? options.properties
            : [];
          for (const property of properties) {
            if (
              property?.type !== "Property" ||
              getPropertyName(property.key) !== "queryKey"
            ) {
              continue;
            }
            const key = literalOf(property.value, "ArrayExpression", context);
            if (!key || property.value.type === "Identifier") {
              continue;
            }
            context.report({ node: key, messageId: "inlineQueryKey" });
          }
        }
      },
      BinaryExpression(node) {
        if (node.operator !== "===" && node.operator !== "!==") {
          return;
        }
        if (!isKeyPositionRead(node.left) && !isKeyPositionRead(node.right)) {
          return;
        }
        if (!isInsidePredicateOption(node)) {
          return;
        }
        context.report({ node, messageId: "inlinePredicate" });
      },
    };
  },
};
