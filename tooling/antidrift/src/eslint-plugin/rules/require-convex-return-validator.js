import ts from "typescript";

import {
  defineTypeScriptRule,
  resolveAliasedSymbol,
} from "../../semantic-adapters/ts-rule-kernel.mjs";

const convexRegistrars = new Set([
  "query",
  "mutation",
  "action",
  "internalQuery",
  "internalMutation",
  "internalAction",
]);

const convexCombinators = new Set(["array", "optional", "union", "record"]);

function symbolDeclaresInConvexPath(symbol, segment) {
  for (const declaration of symbol?.declarations ?? []) {
    const file = declaration.getSourceFile().fileName.replace(/\\/gu, "/");
    const index = file.lastIndexOf("/node_modules/");
    if (index === -1) {
      continue;
    }
    const rest = file.slice(index + "/node_modules/".length);
    if (rest.startsWith("convex/") && rest.includes(segment)) {
      return true;
    }
  }
  return false;
}

function unwrapExpression(node) {
  let current = node;
  while (
    current &&
    (current.type === "TSAsExpression" ||
      current.type === "TSSatisfiesExpression" ||
      current.type === "TSNonNullExpression")
  ) {
    current = current.expression;
  }
  return current;
}

function isConvexRegistrarCall(checker, tsCall) {
  const callee = tsCall.expression;
  const target = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
  if (!ts.isIdentifier(target)) {
    return false;
  }
  const symbol = resolveAliasedSymbol(
    checker,
    checker.getSymbolAtLocation(target)
  );
  const rawName = symbol?.getName() ?? target.text;
  const normalizedName = rawName.replace(/Generic$/u, "");
  if (!convexRegistrars.has(normalizedName)) {
    return false;
  }
  if (symbolDeclaresInConvexPath(symbol, "/server")) {
    return true;
  }
  const calleeType = symbol
    ? checker.getTypeOfSymbolAtLocation(symbol, target)
    : checker.getTypeAtLocation(callee);
  const typeSymbol = calleeType.aliasSymbol ?? calleeType.getSymbol();
  return symbolDeclaresInConvexPath(typeSymbol, "/server");
}

function convexValidatorMethod(node, services, checker) {
  const tsNode = services.esTreeNodeToTSNodeMap.get(node);
  if (
    !tsNode ||
    !ts.isCallExpression(tsNode) ||
    !ts.isPropertyAccessExpression(tsNode.expression)
  ) {
    return null;
  }
  const methodSymbol = resolveAliasedSymbol(
    checker,
    checker.getSymbolAtLocation(tsNode.expression.name)
  );
  const receiverSymbol = resolveAliasedSymbol(
    checker,
    checker.getSymbolAtLocation(tsNode.expression.expression)
  );
  if (
    !symbolDeclaresInConvexPath(methodSymbol, "/values") &&
    !symbolDeclaresInConvexPath(receiverSymbol, "/values")
  ) {
    return null;
  }
  return tsNode.expression.name.text;
}

function containsConvexAny(node, services, checker) {
  const target = unwrapExpression(node);
  if (target?.type !== "CallExpression") {
    return false;
  }
  const method = convexValidatorMethod(target, services, checker);
  if (method === "any") {
    return target.arguments.length === 0;
  }
  if (method === "object") {
    const fields = unwrapExpression(target.arguments[0]);
    return (
      fields?.type === "ObjectExpression" &&
      fields.properties.some(
        (property) =>
          property.type === "Property" &&
          containsConvexAny(property.value, services, checker)
      )
    );
  }
  return (
    convexCombinators.has(method) &&
    target.arguments.some((argument) =>
      containsConvexAny(argument, services, checker)
    )
  );
}

function propertyKeyName(property) {
  if (property.computed) {
    return null;
  }
  if (property.key?.type === "Identifier") {
    return property.key.name;
  }
  return typeof property.key?.value === "string" ? property.key.value : null;
}

function staticReturnsProperty(objectExpression) {
  let returnsProperty = null;
  let hasUnprovableProperty = false;
  for (const property of objectExpression.properties) {
    if (property.type === "SpreadElement" || property.computed) {
      hasUnprovableProperty = true;
      continue;
    }
    if (property.type !== "Property") {
      continue;
    }
    if (propertyKeyName(property) === "returns") {
      returnsProperty = property;
    }
  }
  return { returnsProperty, hasUnprovableProperty };
}

function definitionName(node) {
  let current = node;
  while (current.parent) {
    current = current.parent;
    if (
      current.type === "VariableDeclarator" &&
      current.id.type === "Identifier"
    ) {
      return current.id.name;
    }
    if (current.type === "Property") {
      return propertyKeyName(current);
    }
    if (current.type === "ExportDefaultDeclaration") {
      return "default";
    }
    if (
      current.type === "FunctionDeclaration" ||
      current.type === "FunctionExpression" ||
      current.type === "ArrowFunctionExpression"
    ) {
      return null;
    }
  }
  return null;
}

export function ruleRequireConvexReturnValidator() {
  return defineTypeScriptRule({
    ruleName: "require-convex-return-validator",
    skipGenerated: false,
    meta: {
      type: "problem",
      docs: {
        description:
          "Require an explicit, non-widened returns validator on every registered Convex function (query, mutation, action, and their internal counterparts). The validator completes the chain validator → runtime contract → generated function type → inferred consumer.",
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
        missingReturnValidator:
          "Registered Convex function is missing a returns validator. The returns validator completes the chain validator → runtime contract → generated function type → inferred consumer; without it the generated function type is inferred from the handler implementation, so consumers inherit whatever the handler happens to return.",
        widenedReturn:
          "Return validator widens past the owned shape; return the owning validator, not v.any().",
      },
    },
    visitors({ context, checker, services, options }) {
      const allows = new Set(options[0]?.allows ?? []);
      return {
        CallExpression(node) {
          const firstArgument = unwrapExpression(node.arguments[0]);
          if (!firstArgument || firstArgument.type !== "ObjectExpression") {
            return;
          }
          const tsCall = services.esTreeNodeToTSNodeMap.get(node);
          if (!tsCall || !ts.isCallExpression(tsCall)) {
            return;
          }
          if (!isConvexRegistrarCall(checker, tsCall)) {
            return;
          }
          const { returnsProperty, hasUnprovableProperty } =
            staticReturnsProperty(firstArgument);
          if (!returnsProperty) {
            if (!hasUnprovableProperty) {
              context.report({ node, messageId: "missingReturnValidator" });
            }
            return;
          }
          if (
            !allows.has(definitionName(node)) &&
            containsConvexAny(returnsProperty.value, services, checker)
          ) {
            context.report({
              node: returnsProperty.value,
              messageId: "widenedReturn",
            });
          }
        },
      };
    },
  });
}
