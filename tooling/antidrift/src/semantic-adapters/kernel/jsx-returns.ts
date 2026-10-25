import { AST_NODE_TYPES } from "@typescript-eslint/types";
import type { ParserNode, ParserFunction } from "./syntax-node.ts";
import { isSyntaxNode } from "./syntax-node.ts";
import { isFunctionLike } from "./syntax-function.ts";

function collectJsxLocals(statement: ParserNode, jsxLocals: Set<string>) {
  if (statement.type !== AST_NODE_TYPES.VariableDeclaration) {
    return;
  }
  for (const declaration of statement.declarations) {
    if (
      declaration.id.type === AST_NODE_TYPES.Identifier &&
      containsJsxNode(declaration.init)
    ) {
      jsxLocals.add(declaration.id.name);
    }
  }
}
function returnsJsxExpression(
  statement: ParserNode,
  jsxLocals: ReadonlySet<string>
) {
  if (statement.type !== AST_NODE_TYPES.ReturnStatement) {
    return false;
  }
  if (containsJsxNode(statement.argument)) {
    return true;
  }
  return Boolean(
    statement.argument?.type === AST_NODE_TYPES.Identifier &&
    jsxLocals.has(statement.argument.name)
  );
}
function statementsReturnJsx(
  statements: readonly ParserNode[],
  outerJsxLocals: ReadonlySet<string>
): boolean {
  const jsxLocals = new Set(outerJsxLocals);
  for (const statement of statements) {
    collectJsxLocals(statement, jsxLocals);
    if (statementReturnsJsx(statement, jsxLocals)) {
      return true;
    }
  }
  return false;
}
function statementReturnsJsx(
  statement: ParserNode | null | undefined,
  jsxLocals: ReadonlySet<string>
): boolean {
  switch (statement?.type) {
    case AST_NODE_TYPES.ReturnStatement:
      return returnsJsxExpression(statement, jsxLocals);
    case AST_NODE_TYPES.BlockStatement:
      return statementsReturnJsx(statement.body, jsxLocals);
    case AST_NODE_TYPES.IfStatement:
      return (
        statementReturnsJsx(statement.consequent, jsxLocals) ||
        statementReturnsJsx(statement.alternate, jsxLocals)
      );
    case AST_NODE_TYPES.SwitchStatement:
      return statement.cases.some((switchCase) =>
        statementsReturnJsx(switchCase.consequent, jsxLocals)
      );
    case AST_NODE_TYPES.TryStatement:
      return (
        statementReturnsJsx(statement.block, jsxLocals) ||
        statementReturnsJsx(statement.handler?.body, jsxLocals) ||
        statementReturnsJsx(statement.finalizer, jsxLocals)
      );
    case AST_NODE_TYPES.LabeledStatement:
    case AST_NODE_TYPES.WhileStatement:
    case AST_NODE_TYPES.DoWhileStatement:
    case AST_NODE_TYPES.ForStatement:
    case AST_NODE_TYPES.ForInStatement:
    case AST_NODE_TYPES.ForOfStatement:
      return statementReturnsJsx(statement.body, jsxLocals);
    default:
      return false;
  }
}
export function functionReturnsJsx(
  functionNode: ParserFunction | null | undefined
) {
  if (functionNode?.body.type !== AST_NODE_TYPES.BlockStatement) {
    return containsJsxNode(functionNode?.body);
  }
  return statementsReturnJsx(functionNode.body.body, new Set());
}
function containsJsxNode(node: unknown): boolean {
  if (!isSyntaxNode(node)) {
    return false;
  }
  if (node.type === "JSXElement" || node.type === "JSXFragment") {
    return true;
  }
  if (isFunctionLike(node)) {
    return false;
  }
  for (const [key, child] of Object.entries(node)) {
    if (key === "parent") {
      continue;
    }
    if (
      Array.isArray(child) &&
      child.some((child: unknown) => containsJsxNode(child))
    ) {
      return true;
    }
    if (isSyntaxNode(child) && containsJsxNode(child)) {
      return true;
    }
  }
  return false;
}
