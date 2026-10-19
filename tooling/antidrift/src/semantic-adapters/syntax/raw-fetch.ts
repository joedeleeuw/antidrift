import {
  isSyntaxType,
  identifierName,
  syntaxField,
} from "../kernel/syntax-node.ts";
import type { Rule } from "eslint";
import { bindingDefinitions } from "../kernel/syntax-scope.ts";
import { findVariable } from "../kernel/async-control-flow.ts";
import { containsJsxNode } from "../kernel/jsx-returns.ts";

type FetchFunction =
  | Parameters<NonNullable<Rule.RuleListener["FunctionDeclaration"]>>[0]
  | Parameters<NonNullable<Rule.RuleListener["FunctionExpression"]>>[0]
  | Parameters<NonNullable<Rule.RuleListener["ArrowFunctionExpression"]>>[0];
type FetchCall = Parameters<
  NonNullable<Rule.RuleListener["CallExpression"]>
>[0];
type FetchFrame = {
  returnsJsx: boolean;
  readonly fetches: FetchCall[];
  readonly jsxLocals: Set<string>;
};
function isUnshadowedGlobalName(
  sourceCode: Rule.RuleContext["sourceCode"],
  identifier: unknown,
  name: string
) {
  if (
    !isSyntaxType(identifier, "Identifier") ||
    identifierName(identifier) !== name
  ) {
    return false;
  }
  const binding = findVariable(sourceCode, identifier);
  return !binding || bindingDefinitions(binding).length === 0;
}
function isGlobalFetchCall(
  context: Pick<Rule.RuleContext, "sourceCode">,
  callee: unknown
) {
  if (isSyntaxType(callee, "Identifier")) {
    return isUnshadowedGlobalName(context.sourceCode, callee, "fetch");
  }
  if (
    !isSyntaxType(callee, "MemberExpression") ||
    syntaxField(callee, "computed")
  ) {
    return false;
  }
  const propertyName = identifierName(syntaxField(callee, "property")) ?? "";
  return (
    propertyName === "fetch" &&
    ["globalThis", "window", "self"].some((name) =>
      isUnshadowedGlobalName(
        context.sourceCode,
        syntaxField(callee, "object"),
        name
      )
    )
  );
}
export const ruleNoRawFetchInComponent = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow raw fetch calls inside React components.",
    },
    schema: [],
  },
  create(context: Rule.RuleContext): Rule.RuleListener {
    const stack: FetchFrame[] = [];
    function enterFunction(node: FetchFunction) {
      stack.push({
        returnsJsx:
          node.type === "ArrowFunctionExpression" && containsJsxNode(node.body),
        fetches: [],
        jsxLocals: new Set(),
      });
    }
    function exitFunction() {
      const frame = stack.pop();
      if (!frame) {
        return;
      }
      if (!frame.returnsJsx) {
        stack[stack.length - 1]?.fetches.push(...frame.fetches);
        return;
      }
      for (const node of frame.fetches) {
        context.report({
          node,
          message:
            "Do not call raw fetch inside React components. Use an API client, loader, or query resource.",
        });
      }
    }
    return {
      FunctionDeclaration: enterFunction,
      "FunctionDeclaration:exit": exitFunction,
      FunctionExpression: enterFunction,
      "FunctionExpression:exit": exitFunction,
      ArrowFunctionExpression: enterFunction,
      "ArrowFunctionExpression:exit": exitFunction,
      VariableDeclarator(node) {
        const frame = stack.at(-1);
        if (
          frame &&
          node.id.type === "Identifier" &&
          containsJsxNode(node.init)
        ) {
          frame.jsxLocals.add(node.id.name);
        }
      },
      ReturnStatement(node) {
        const frame = stack.at(-1);
        if (!frame) {
          return;
        }
        if (
          containsJsxNode(node.argument) ||
          (node.argument?.type === "Identifier" &&
            frame.jsxLocals.has(node.argument.name))
        ) {
          frame.returnsJsx = true;
        }
      },
      CallExpression(node) {
        if (isGlobalFetchCall(context, node.callee)) {
          stack.at(-1)?.fetches.push(node);
        }
      },
    };
  },
} satisfies Rule.RuleModule;
