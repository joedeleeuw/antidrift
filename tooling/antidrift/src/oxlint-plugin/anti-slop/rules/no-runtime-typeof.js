import { defineRule } from "@oxlint/plugins";
import { isUnshadowedGlobal } from "../../unknown-sinks.js";
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
// legitimately feature-detected at runtime (`typeof window`,
// `typeof globalThis.navigator?.share === "function"`).
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
// A capability check compares the `typeof` of a global-rooted operand against
// "undefined" (presence) or "function" (method surface). Any other comparison
// target is value narrowing, as is a bare `typeof` with no comparison.
function isPresenceOrFunctionComparison(node) {
  const parent = node.parent;
  if (parent?.type !== "BinaryExpression") return false;
  if (!["===", "!==", "==", "!="].includes(parent.operator)) return false;
  const other = parent.left === node ? parent.right : parent.left;
  return (
    other.type === "Literal" &&
    (other.value === "undefined" || other.value === "function")
  );
}
function capabilityRoot(argument) {
  let node = argument;
  while (node.type === "ChainExpression") node = node.expression;
  while (node.type === "MemberExpression") node = node.object;
  return node.type === "Identifier" &&
    CAPABILITY_GLOBAL_ROOTS.has(node.name)
    ? node
    : null;
}
function isCapabilityCheck(node, sourceCode) {
  if (!isPresenceOrFunctionComparison(node)) return false;
  const root = capabilityRoot(node.argument);
  return root !== null && isUnshadowedGlobal(sourceCode, root);
}
/** Disallow runtime typeof checks that narrow unparsed values instead of decoding them. */
export const noRuntimeTypeofRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow runtime typeof checks; external values must be decoded into meaningful types at their I/O boundary. Capability checks are exempt only when the operand is rooted at an unshadowed platform global (window, document, navigator, globalThis, self, global, process, localStorage, sessionStorage) and the result is compared with \"undefined\" or \"function\".",
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
          !isCapabilityCheck(node, context.sourceCode) &&
          (!allowInTypeGuards || !isInsideTypeGuard(node))
        ) {
          context.report({ node, messageId: "runtimeTypeof" });
        }
      },
    };
  },
});
