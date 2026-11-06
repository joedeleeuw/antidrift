import { isRuleFile, scopeProperties } from "../shared/rule-scope.js";
import { unwrapExpression } from "../shared/scope.js";
import { isIdentifier } from "./ast.js";
import {
  isBrowserGlobalHost,
  isGlobalReference,
  resolveStaticMemberName,
} from "./static-resolution.js";

const isBrowserOpenCallee = (sourceCode, callee) => {
  const unwrappedCallee = unwrapExpression(callee);
  if (isIdentifier(unwrappedCallee, "open")) {
    return isGlobalReference(sourceCode, unwrappedCallee);
  }
  if (
    unwrappedCallee === null ||
    unwrappedCallee.type !== "MemberExpression" ||
    resolveStaticMemberName(sourceCode, unwrappedCallee) !== "open"
  ) {
    return false;
  }
  return isBrowserGlobalHost(sourceCode, unwrappedCallee.object);
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
      requireSafeWindowOpen:
        "Pass noopener or noreferrer in the third argument to window.open() so the browser isolates the opener.",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};

    return {
      CallExpression(node) {
        if (!isBrowserOpenCallee(context.sourceCode, node.callee)) {
          return;
        }
        const target = node.arguments[1];
        if (target?.type === "Literal" && target.value === "_self") return;
        const url = node.arguments[0];
        const retained = [
          "VariableDeclarator",
          "AssignmentExpression",
          "ReturnStatement",
          "MemberExpression",
        ].includes(node.parent?.type);
        if (
          retained &&
          (!url ||
            (url.type === "Literal" &&
              (url.value === "" || url.value === "about:blank")))
        ) {
          return;
        }
        const features = node.arguments[2];
        if (
          features?.type === "Literal" &&
          typeof features.value === "string" &&
          /(?:^|,)\s*(?:noopener|noreferrer)(?:\s|,|$)/u.test(features.value)
        ) {
          return;
        }
        context.report({
          node,
          messageId: "requireSafeWindowOpen",
        });
      },
    };
  },
};
