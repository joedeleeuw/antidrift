import type * as ts from "typescript";

export type TypeScriptParserServices = {
  esTreeNodeToTSNodeMap: {
    get(node: unknown): ts.Node | undefined;
  };
};

export interface StringTypeofGuard {
  truthy: boolean;
  falsy: boolean;
}

export function unwrapExpression(expression: unknown): unknown;

export function sameExpression(left: unknown, right: unknown): boolean;

export function isStringLiteralNode(node: unknown): boolean;

export function typeofOperand(node: unknown): unknown | null;

export function stringTypeofGuard(
  condition: unknown,
  expression: unknown,
): StringTypeofGuard | null;

export function conditionEnsuresString(
  condition: unknown,
  expression: unknown,
  whenTruthy: boolean,
): boolean;

export function nodeWithin(node: unknown, ancestor: unknown): boolean;

export function statementAlwaysExits(statement: unknown): boolean;

export function enclosingBlockStatement(node: unknown): unknown | null;

export function safeBetweenStringGuardAndParse(statement: unknown): boolean;

export function previousGuardInBlockEnsuresString(
  statement: unknown,
  expression: unknown,
): boolean;

export function priorGuardEnsuresString(
  node: unknown,
  expression: unknown,
): boolean;

export function branchGuardEnsuresString(
  node: unknown,
  expression: unknown,
): boolean;

export function hasLocalStringBoundary(
  node: unknown,
  expression: unknown,
): boolean;

export function isAnyOrUnknownType(type: ts.Type | null | undefined): boolean;

export function isJsonParseCall(node: unknown): boolean;

export function jsonParseArgument(node: unknown): unknown | null;

export function isUnsafeJsonParseInput(
  node: unknown,
  services: TypeScriptParserServices,
  checker: ts.TypeChecker,
): boolean;
