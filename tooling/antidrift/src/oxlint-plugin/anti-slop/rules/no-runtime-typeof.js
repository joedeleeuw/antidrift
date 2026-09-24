import { defineRule } from "@oxlint/plugins";
function isRuntimeFunction(node) {
  return (
    node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression"
  );
}
function isInsideTypeGuard(node) {
  let current = node.parent;
  while (current !== null && current.type !== "Program") {
    if (isRuntimeFunction(current)) {
      return current.returnType?.typeAnnotation.type === "TSTypePredicate";
    }
    current = current.parent;
  }
  return false;
}
// Host-environment global objects whose presence or method surface is
// legitimately feature-detected at runtime (`typeof window`, `typeof
// globalThis.navigator?.share === "function"`). A `typeof` rooted at one of
// these checks platform capability, not an unparsed value, so it is exempt.
const CAPABILITY_GLOBAL_ROOTS = new Set([
  "window",
  "document",
  "navigator",
  "globalThis",
  "self",
  "global",
  "process",
  "localStorage",
  "sessionStorage",
]);
function isCapabilityCheck(argument) {
  let node = argument;
  while (node.type === "ChainExpression") node = node.expression;
  while (node.type === "MemberExpression") node = node.object;
  return node.type === "Identifier" && CAPABILITY_GLOBAL_ROOTS.has(node.name);
}
/** Disallow runtime typeof checks that narrow unparsed values instead of decoding them. */
export const noRuntimeTypeofRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow runtime typeof checks; external values must be decoded into meaningful types at their I/O boundary. Capability checks rooted at a platform global (window, document, navigator, globalThis, self, global, process, localStorage, sessionStorage) are exempt.",
    },
    messages: {
      runtimeTypeof:
        "A `typeof` check narrows a representation without establishing its contract. Parse input at its I/O boundary, then branch on the domain value.",
    },
    schema: [
      {
        type: "object",
        properties: {
          allowInTypeGuards: { type: "boolean" },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ allowInTypeGuards: false }],
  },
  createOnce(context) {
    return {
      UnaryExpression(node) {
        const option = context.options?.[0];
        const allowInTypeGuards =
          typeof option === "object" &&
          option !== null &&
          !Array.isArray(option) &&
          option.allowInTypeGuards === true;
        if (
          node.operator === "typeof" &&
          !isCapabilityCheck(node.argument) &&
          (!allowInTypeGuards || !isInsideTypeGuard(node))
        ) {
          context.report({ node, messageId: "runtimeTypeof" });
        }
      },
    };
  },
});
