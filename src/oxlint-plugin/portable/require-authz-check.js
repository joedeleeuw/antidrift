import { isRuleFile, scopeProperties } from "../shared/rule-scope.js";

const REQUEST_PARAM_ROOTS = new Set([
  "req",
  "request",
  "ctx",
  "context",
  "event",
]);

function calleeName(callee) {
  if (!callee) return null;
  if (callee.type === "Identifier") return callee.name;
  if (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property?.type === "Identifier"
  ) {
    return callee.property.name;
  }
  return null;
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Require an authorization/ownership check when a handler reads request params.",
    },
    schema: [
      {
        type: "object",
        properties: {
          ...scopeProperties,
          authzFunctions: {
            type: "array",
            items: { type: "string", minLength: 1 },
            uniqueItems: true,
          },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    const configured = context.options[0]?.authzFunctions ?? [];
    if (
      !Array.isArray(configured) ||
      configured.some((name) => typeof name !== "string")
    ) {
      throw new TypeError("authzFunctions must be strings");
    }
    if (configured.length === 0) return {};
    const authzSet = new Set(configured);
    const stack = [];
    const enter = (node) => {
      stack.push({ node, paramsAccess: null, sawAuthz: false });
    };
    const exit = () => {
      const frame = stack.pop();
      if (frame?.paramsAccess && !frame.sawAuthz) {
        context.report({
          node: frame.paramsAccess,
          message:
            "Handler reads request params without a configured authorization/ownership check.",
        });
      }
    };
    return {
      FunctionDeclaration: enter,
      "FunctionDeclaration:exit": exit,
      FunctionExpression: enter,
      "FunctionExpression:exit": exit,
      ArrowFunctionExpression: enter,
      "ArrowFunctionExpression:exit": exit,
      MemberExpression(node) {
        const frame = stack.at(-1);
        if (
          frame &&
          !node.computed &&
          node.property?.type === "Identifier" &&
          node.property.name === "params" &&
          node.object?.type === "Identifier" &&
          REQUEST_PARAM_ROOTS.has(node.object.name)
        ) {
          frame.paramsAccess ??= node;
        }
      },
      CallExpression(node) {
        const frame = stack.at(-1);
        const name = calleeName(node.callee);
        if (frame && name && authzSet.has(name)) {
          frame.sawAuthz = true;
        }
      },
    };
  },
};
