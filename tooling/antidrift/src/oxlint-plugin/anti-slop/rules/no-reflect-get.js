import { defineRule } from "@oxlint/plugins";
import {
  isGlobalReflectMethodCall,
  isUnshadowedGlobal,
} from "../shared/reflect-method.js";

// Host objects whose properties vary by runtime (browser, Electron, Node,
// workers), so no static type can describe them.
const PLATFORM_GLOBALS = new Set([
  "globalThis",
  "window",
  "self",
  "global",
  "document",
  "navigator",
  "location",
  "process",
]);

function isPlatformGlobal(sourceCode, node) {
  return (
    node?.type === "Identifier" &&
    PLATFORM_GLOBALS.has(node.name) &&
    isUnshadowedGlobal(sourceCode, node)
  );
}

// `typeof Reflect.get(x, "method") === "function"` probes a capability before
// calling it; the read result is never trusted as a typed value.
function isTypeofFunctionProbe(node) {
  const typeofNode = node.parent;
  if (
    typeofNode?.type !== "UnaryExpression" ||
    typeofNode.operator !== "typeof"
  )
    return false;
  const comparison = typeofNode.parent;
  if (
    comparison?.type !== "BinaryExpression" ||
    !["===", "!==", "==", "!="].includes(comparison.operator)
  )
    return false;
  const other =
    comparison.left === typeofNode ? comparison.right : comparison.left;
  return other.type === "Literal" && other.value === "function";
}

/** Ban Reflect.get, which bypasses ordinary property access and useful type evidence. */
export const noReflectGetRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow Reflect.get; use typed property access or parse dynamic input into a domain type.",
    },
    messages: {
      reflectGet:
        "Replace `Reflect.get` with typed property access. Parse dynamic input into a named domain type before reading it.",
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        if (
          node.callee.type === "Super" ||
          node.callee.type === "V8IntrinsicExpression"
        )
          return;
        if (!isGlobalReflectMethodCall(context.sourceCode, node.callee, "get"))
          return;
        if (
          isPlatformGlobal(context.sourceCode, node.arguments[0]) ||
          isTypeofFunctionProbe(node)
        )
          return;
        context.report({ node, messageId: "reflectGet" });
      },
    };
  },
});
