import { findVariable } from "../../semantic-adapters/async-control-flow.mjs";

const BUILDERS = new Set([
  "query",
  "mutation",
  "action",
  "internalQuery",
  "internalMutation",
  "internalAction",
]);
const COMBINATORS = new Set(["array", "optional", "union", "record"]);

function propertyName(node) {
  if (!node.computed && node.property?.type === "Identifier") {
    return node.property.name;
  }
  if (
    node.property?.type === "Literal" &&
    typeof node.property.value === "string"
  ) {
    return node.property.value;
  }
  if (!node.computed && node.key?.type === "Identifier") return node.key.name;
  return node.key?.type === "Literal" ? node.key.value : null;
}

function unwrap(node) {
  let current = node;
  while (
    current &&
    ["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression"].includes(
      current.type,
    )
  ) {
    current = current.expression;
  }
  return current;
}

function importedName(node, sourceCode) {
  if (node.type === "MemberExpression" && node.object.type === "Identifier") {
    const variable = findVariable(sourceCode, node.object);
    const definition = variable?.defs[0];
    if (
      definition?.node.type !== "ImportNamespaceSpecifier" ||
      definition.parent.importKind === "type"
    ) {
      return null;
    }
    return { name: propertyName(node), module: definition.parent.source.value };
  }
  if (node.type !== "Identifier") return null;
  const variable = findVariable(sourceCode, node);
  const definition = variable?.defs[0];
  if (
    definition?.node.type !== "ImportSpecifier" ||
    definition.node.importKind === "type" ||
    definition.parent.importKind === "type"
  ) {
    return null;
  }
  return {
    name: definition.node.imported.name ?? definition.node.imported.value,
    module: definition.parent.source.value,
  };
}

function isConvexDefinition(node, sourceCode) {
  if (node.optional) return false;
  const imported = importedName(unwrap(node.callee), sourceCode);
  if (!imported) return false;
  if (imported.module === "convex/server") {
    return BUILDERS.has(imported.name?.replace(/Generic$/u, ""));
  }
  return (
    /(?:^|\/)_generated\/server(?:\.[cm]?[jt]s)?$/u.test(imported.module) &&
    BUILDERS.has(imported.name)
  );
}

function validatorMethod(node, sourceCode) {
  const call = unwrap(node);
  if (
    call?.type !== "CallExpression" ||
    call.callee.type !== "MemberExpression"
  ) {
    return null;
  }
  const imported = importedName(call.callee.object, sourceCode);
  if (imported?.module !== "convex/values" || imported.name !== "v") {
    return null;
  }
  return propertyName(call.callee);
}

function containsAny(node, sourceCode) {
  const target = unwrap(node);
  const method = validatorMethod(target, sourceCode);
  if (method === "any") return target.arguments.length === 0;
  if (method === "object") {
    const fields = unwrap(target.arguments[0]);
    return (
      fields?.type === "ObjectExpression" &&
      fields.properties.some(
        (property) =>
          property.type === "Property" &&
          containsAny(property.value, sourceCode),
      )
    );
  }
  return (
    COMBINATORS.has(method) &&
    target.arguments.some((argument) => containsAny(argument, sourceCode))
  );
}

function definitionName(node) {
  let current = node;
  while (current.parent) {
    current = current.parent;
    if (current.type === "VariableDeclarator") return current.id.name;
    if (current.type === "Property") return propertyName(current);
    if (current.type === "ExportDefaultDeclaration") return "default";
    if (
      [
        "FunctionDeclaration",
        "FunctionExpression",
        "ArrowFunctionExpression",
      ].includes(current.type)
    ) {
      return null;
    }
  }
  return null;
}

export default function ruleNoConvexReturnWidening() {
  return {
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow v.any() leaves in Convex function return validators.",
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
        widenedReturn:
          "Return validator widens past the owned shape; return the owning validator, not v.any().",
      },
    },
    create(context) {
      const allows = new Set(context.options[0]?.allows ?? []);
      return {
        CallExpression(node) {
          if (
            !isConvexDefinition(node, context.sourceCode) ||
            allows.has(definitionName(node))
          ) {
            return;
          }
          const definition = unwrap(node.arguments[0]);
          if (definition?.type !== "ObjectExpression") return;
          const returns = definition.properties.findLast(
            (property) =>
              property.type === "Property" &&
              propertyName(property) === "returns",
          );
          if (returns && containsAny(returns.value, context.sourceCode)) {
            context.report({ node: returns.value, messageId: "widenedReturn" });
          }
        },
      };
    },
  };
}
