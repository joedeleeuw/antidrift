import ts from "typescript";

import type { TypeScriptParserServices } from "../kernel/rule-kernel.ts";
import {
  isSyntaxNode,
  isSyntaxType,
  syntaxChildren,
  syntaxField,
} from "../kernel/syntax-node.ts";
import { memberTypes } from "../kernel/typescript-internals.ts";

export type { TypeScriptParserServices } from "../kernel/rule-kernel.ts";

export type TupleTypeEvidence = {
  readonly services?: TypeScriptParserServices | undefined;
  readonly checker?: ts.TypeChecker | undefined;
};

const DIRECT_NULLISH_TYPE_NODES = new Set([
  "TSNullKeyword",
  "TSUndefinedKeyword",
  "TSVoidKeyword",
]);

export function typeIncludesNullish(
  type: ts.Type | null | undefined,
  seen = new Set<ts.Type>()
): boolean {
  if (!type || seen.has(type)) {
    return false;
  }
  seen.add(type);
  if ((type.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) !== 0) {
    return true;
  }
  return memberTypes(type).some((part) => typeIncludesNullish(part, seen));
}

export function tupleElementTypeNode(element: unknown) {
  if (isSyntaxType(element, "TSNamedTupleMember")) {
    return syntaxField(element, "elementType");
  }
  if (
    isSyntaxType(element, "TSOptionalType") ||
    isSyntaxType(element, "TSRestType")
  ) {
    return syntaxField(element, "typeAnnotation");
  }
  return element;
}

export function tupleElementIsOptional(element: unknown): boolean {
  return (
    syntaxField(element, "optional") === true ||
    isSyntaxType(element, "TSOptionalType") ||
    (isSyntaxType(element, "TSNamedTupleMember") &&
      isSyntaxType(syntaxField(element, "elementType"), "TSOptionalType"))
  );
}

export function typeNodeIncludesDirectNullish(typeNode: unknown): boolean {
  const node = tupleElementTypeNode(typeNode);
  if (!isSyntaxNode(node)) {
    return false;
  }
  if (DIRECT_NULLISH_TYPE_NODES.has(node.type)) {
    return true;
  }
  if (node.type === "TSUnionType") {
    return syntaxChildren(node, "types").some(typeNodeIncludesDirectNullish);
  }
  if (node.type === "TSParenthesizedType") {
    return typeNodeIncludesDirectNullish(syntaxField(node, "typeAnnotation"));
  }
  return false;
}

export function tupleElementResolvesToNullish(
  element: unknown,
  services?: TypeScriptParserServices,
  checker?: ts.TypeChecker
): boolean {
  const typeNode = tupleElementTypeNode(element);
  if (!checker || !typeNode) {
    return false;
  }
  const tsTypeNode = services?.esTreeNodeToTSNodeMap.get(typeNode);
  return (
    tsTypeNode !== undefined &&
    ts.isTypeNode(tsTypeNode) &&
    typeIncludesNullish(checker.getTypeFromTypeNode(tsTypeNode))
  );
}

function nullishSlotTest(
  evidence: TupleTypeEvidence
): (element: unknown) => boolean {
  return (element) =>
    tupleElementIsOptional(element) ||
    typeNodeIncludesDirectNullish(element) ||
    tupleElementResolvesToNullish(element, evidence.services, evidence.checker);
}

export function tupleElementIsNullishSlot(
  element: unknown,
  evidence: TupleTypeEvidence = {}
): boolean {
  return nullishSlotTest(evidence)(element);
}

export function nullableTupleSlots(
  node: unknown,
  evidence: TupleTypeEvidence = {}
): unknown[] {
  return syntaxChildren(node, "elementTypes").filter(nullishSlotTest(evidence));
}

export function hasNullablePositionalTuple(
  node: unknown,
  evidence: TupleTypeEvidence = {},
  threshold = 2
): boolean {
  return nullableTupleSlots(node, evidence).length >= threshold;
}
