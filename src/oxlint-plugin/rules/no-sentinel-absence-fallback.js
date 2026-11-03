import { mergeVisitors } from "../shared/merge-visitors.js";
import { silentEmptyDetectionVisitors } from "./absence-fallback/silent-empty-detection.js";
import { isFunctionLike, unwrapExpression } from "../shared/scope.js";

const sentinelLiterals = new Set([
  "unknown",
  "n/a",
  "none",
  "unavailable",
  "error",
  "missing",
]);

function isZeroLiteral(node) {
  const expr = unwrapExpression(node);
  return expr?.type === "Literal" && expr.value === 0;
}

function isEmptyStringNode(node) {
  const expr = unwrapExpression(node);
  return (
    (expr?.type === "Literal" && expr.value === "") ||
    (expr?.type === "TemplateLiteral" &&
      expr.expressions.length === 0 &&
      expr.quasis.length === 1 &&
      expr.quasis[0].value.cooked === "")
  );
}

function isProcessEnvAccess(node) {
  const expr = unwrapExpression(node);
  return (
    expr?.type === "MemberExpression" &&
    expr.object?.type === "MemberExpression" &&
    !expr.object.computed &&
    expr.object.object?.type === "Identifier" &&
    expr.object.object.name === "process" &&
    expr.object.property?.type === "Identifier" &&
    expr.object.property.name === "env"
  );
}

const SIZE_PROPERTIES = new Set(["length", "size", "count"]);

function hasOptionalChain(node) {
  const expr = unwrapExpression(node);
  if (!expr) return false;
  if (expr.type === "MemberExpression" || expr.type === "CallExpression") {
    return (
      Boolean(expr.optional) || hasOptionalChain(expr.object ?? expr.callee)
    );
  }
  return false;
}

function isOptionalChainSizeAccess(node) {
  const expr = unwrapExpression(node);
  return (
    expr?.type === "MemberExpression" &&
    !expr.computed &&
    expr.property?.type === "Identifier" &&
    SIZE_PROPERTIES.has(expr.property.name) &&
    hasOptionalChain(expr)
  );
}

function matchedSentinelLiteral(node) {
  const expression = unwrapExpression(node);
  if (!expression) return "";
  if (expression.type === "Literal" && typeof expression.value === "string") {
    return sentinelLiterals.has(expression.value.toLowerCase())
      ? expression.value
      : "";
  }
  if (
    expression.type === "TemplateLiteral" &&
    expression.expressions.length === 0 &&
    expression.quasis.length === 1
  ) {
    const cooked = expression.quasis[0].value.cooked;
    return typeof cooked === "string" &&
      sentinelLiterals.has(cooked.toLowerCase())
      ? cooked
      : "";
  }
  return "";
}

function isPlatformOsEquality(testNode) {
  const test = unwrapExpression(testNode);
  if (
    test?.type !== "BinaryExpression" ||
    (test.operator !== "===" && test.operator !== "!==")
  ) {
    return false;
  }
  const member =
    test.left?.type === "MemberExpression" ? test.left : test.right;
  const literal = member === test.left ? test.right : test.left;
  return (
    member?.type === "MemberExpression" &&
    !member.computed &&
    member.object?.type === "Identifier" &&
    member.object.name === "Platform" &&
    member.property?.type === "Identifier" &&
    member.property.name === "OS" &&
    literal?.type === "Literal" &&
    typeof literal.value === "string"
  );
}

function checkFunctionReturnSentinels(fnNode, context) {
  if (fnNode.body?.type !== "BlockStatement") return;
  let nullNode = null;
  let emptyStringNode = null;
  function walk(cur) {
    if (!cur || typeof cur !== "object") return;
    if (cur !== fnNode && isFunctionLike(cur)) return;
    if (cur.type === "ReturnStatement" && cur.argument) {
      const arg = unwrapExpression(cur.argument);
      if (arg?.type === "Literal" && arg.value === null) {
        nullNode ??= cur;
      } else if (isEmptyStringNode(arg)) {
        emptyStringNode ??= cur;
      }
    }
    for (const [key, child] of Object.entries(cur)) {
      if (key === "parent" || key === "range" || key === "loc") continue;
      if (Array.isArray(child)) {
        for (const elem of child) walk(elem);
      } else if (child && typeof child.type === "string") {
        walk(child);
      }
    }
  }
  walk(fnNode.body);
  if (nullNode && emptyStringNode) {
    context.report({
      node: emptyStringNode,
      messageId: "dualEmptySentinel",
    });
  }
}

function checkLogicalSentinel(node, memberSentinels, context) {
  if (
    (node.operator === "??" || node.operator === "||") &&
    isProcessEnvAccess(node.left) &&
    isEmptyStringNode(node.right)
  ) {
    context.report({
      node,
      messageId: "envEmptyFallback",
    });
    return;
  }
  if (
    !memberSentinels ||
    node.operator !== "??" ||
    node.parent?.type === "TemplateLiteral" ||
    node.parent?.type === "NewExpression" ||
    unwrapExpression(node.left)?.type !== "MemberExpression"
  ) {
    return;
  }
  const sentinel = matchedSentinelLiteral(node.right);
  if (!sentinel) return;
  context.report({
    node,
    messageId: "sentinelAbsenceFallback",
    data: { sentinel },
  });
}

function checkPlatformSelector(node, context) {
  if (
    node.parent?.type !== "ConditionalExpression" &&
    node.consequent?.type !== "ConditionalExpression" &&
    node.alternate?.type !== "ConditionalExpression" &&
    isPlatformOsEquality(node.test) &&
    node.consequent?.type === "Literal" &&
    node.alternate?.type === "Literal" &&
    typeof node.consequent.value === "string" &&
    typeof node.alternate.value === "string" &&
    node.consequent.value.length > 0 &&
    node.alternate.value.length > 0
  ) {
    context.report({
      node,
      messageId: "twoBranchPlatformSelector",
    });
  }
}

function createSentinelVisitors(context, memberSentinels) {
  return mergeVisitors(
    {
      LogicalExpression(node) {
        checkLogicalSentinel(node, memberSentinels, context);
      },
      BinaryExpression(node) {
        if (node.operator !== "!==" && node.operator !== "!=") return;
        const leftChain =
          isOptionalChainSizeAccess(node.left) && isZeroLiteral(node.right);
        const rightChain =
          isOptionalChainSizeAccess(node.right) && isZeroLiteral(node.left);
        if (leftChain || rightChain) {
          context.report({
            node,
            messageId: "optionalChainZeroInequality",
          });
        }
      },
      ConditionalExpression(node) {
        checkPlatformSelector(node, context);
      },
      FunctionDeclaration(node) {
        checkFunctionReturnSentinels(node, context);
      },
      FunctionExpression(node) {
        checkFunctionReturnSentinels(node, context);
      },
      ArrowFunctionExpression(node) {
        checkFunctionReturnSentinels(node, context);
      },
    },
    silentEmptyDetectionVisitors(context)
  );
}

export default function ruleNoSentinelAbsenceFallback() {
  return {
    meta: {
      type: "problem",
      docs: {
        description:
          "Keep missing member values and detection failures distinct from real values.",
      },
      schema: [
        {
          type: "object",
          properties: { memberSentinels: { type: "boolean" } },
          additionalProperties: false,
        },
      ],
      messages: {
        optionalChainZeroInequality:
          "Optional-chain inequality against 0 evaluates to true when the chain short-circuits to undefined; use `(x?.length ?? 0) > 0` instead.",
        sentinelAbsenceFallback:
          'This fallback hides a missing member behind "{{sentinel}}". Keep the missing value distinct from a reported value.',
        envEmptyFallback:
          "Defaulting `process.env.*` to an empty string hides missing configuration; decode required env vars at the boundary or keep `undefined` explicit.",
        twoBranchPlatformSelector:
          "Two-branch `Platform.OS` ternary collapses all other platforms into the fallback branch; use `Platform.select` or an explicit platform table.",
        dualEmptySentinel:
          'Function returns both `null` and `""` as absence sentinels; pick one canonical absence representation.',
        noSilentEmptyFallback:
          "Do not return an empty string from {{name}} (source: {{source}}). Throw or return an explicit nullable/result value so callers cannot confuse detection failure with a real value.",
      },
    },
    create(context) {
      const memberSentinels = context.options[0]?.memberSentinels !== false;
      return createSentinelVisitors(context, memberSentinels);
    },
  };
}
