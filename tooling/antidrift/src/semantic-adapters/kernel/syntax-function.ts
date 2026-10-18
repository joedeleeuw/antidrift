import type { SyntaxNode } from "./syntax-node.ts";
import { isSyntaxType, isSyntaxTypeIn, syntaxField } from "./syntax-node.ts";

const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

const FUNCTION_VALUE_TYPES = new Set([
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

export const memberNodeTypes = new Set([
  "MethodDefinition",
  "PropertyDefinition",
  "Property",
]);

export function isFunctionLike(node: unknown): node is SyntaxNode {
  return isSyntaxTypeIn(node, FUNCTION_TYPES);
}

export function getFunctionNode(node: unknown) {
  if (isFunctionLike(node)) {
    return node;
  }
  if (isSyntaxType(node, "VariableDeclarator")) {
    return syntaxField(node, "init");
  }
  const memberFunction = isSyntaxTypeIn(node, memberNodeTypes)
    ? syntaxField(node, "value")
    : null;
  return isSyntaxTypeIn(memberFunction, FUNCTION_VALUE_TYPES)
    ? memberFunction
    : null;
}
