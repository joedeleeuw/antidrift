import type * as ts from "typescript";

export type TypeScriptParserServices = {
  esTreeNodeToTSNodeMap: {
    get(node: unknown): ts.Node | undefined;
  };
};

export function typeIncludesNullish(
  type: ts.Type | null | undefined,
  seen?: Set<ts.Type>,
): boolean;

export function tupleElementTypeNode(element: unknown): unknown;

export function tupleElementIsOptional(element: unknown): boolean;

export function typeNodeIncludesDirectNullish(typeNode: unknown): boolean;

export function tupleElementResolvesToNullish(
  element: unknown,
  services?: TypeScriptParserServices,
  checker?: ts.TypeChecker,
): boolean;

export function tupleElementIsNullishSlot(
  element: unknown,
  services?: TypeScriptParserServices,
  checker?: ts.TypeChecker,
): boolean;

export function nullableTupleSlots(
  node: unknown,
  services?: TypeScriptParserServices,
  checker?: ts.TypeChecker,
): unknown[];

export function hasNullablePositionalTuple(
  node: unknown,
  services?: TypeScriptParserServices,
  checker?: ts.TypeChecker,
  threshold?: number,
): boolean;
