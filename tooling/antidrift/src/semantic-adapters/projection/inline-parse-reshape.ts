import ts from "typescript";

import { unwrapTransparent } from "../kernel/transparent-expression.ts";
import { symbolAtNode } from "../provenance/symbol-provenance.ts";
import type { BagScope } from "./bag-projection.ts";
import {
  inspectBagValueExpression,
  inspectObjectLiteralBagProjection,
  isBagObjectReference,
  isPureBagCondition,
  isStaticMemberAccess,
} from "./bag-projection.ts";

type RootSource = { readonly symbol: ts.Symbol; readonly name: string };

const COMBINATOR_METHODS = new Set(["preprocess", "transform"]);

function memberRoot(expression: ts.Expression): ts.Expression {
  let base = unwrapTransparent(expression);
  while (isStaticMemberAccess(base)) {
    base = unwrapTransparent(base.expression);
  }
  return base;
}

function rootIdentifierSource(
  checker: ts.TypeChecker,
  identifier: ts.Identifier
): RootSource | null {
  const symbol = symbolAtNode(checker, identifier);
  return symbol ? { symbol, name: identifier.text } : null;
}

function findSingleRootSource(
  checker: ts.TypeChecker,
  node: ts.Node
): RootSource | null {
  const unwrapped = unwrapTransparent(node);
  if (isStaticMemberAccess(unwrapped)) {
    const base = memberRoot(unwrapped.expression);
    return ts.isIdentifier(base) ? rootIdentifierSource(checker, base) : null;
  }
  if (ts.isSpreadAssignment(unwrapped)) {
    const target = unwrapTransparent(unwrapped.expression);
    return ts.isIdentifier(target)
      ? rootIdentifierSource(checker, target)
      : findSingleRootSource(checker, target);
  }
  return (
    ts.forEachChild(
      unwrapped,
      (child) => findSingleRootSource(checker, child) ?? undefined
    ) ?? null
  );
}

function isInlineReshapeBranch(
  scope: BagScope,
  branch: ts.Expression
): boolean {
  const unwrapped = unwrapTransparent(branch);
  if (isBagObjectReference(scope, unwrapped)) {
    return true;
  }
  return (
    ts.isObjectLiteralExpression(unwrapped) &&
    unwrapped.properties.length > 0 &&
    unwrapped.properties.every((property) =>
      ts.isSpreadAssignment(property)
        ? isBagObjectReference(scope, property.expression)
        : ts.isPropertyAssignment(property) &&
          inspectBagValueExpression(scope, property.initializer).valid
    )
  );
}

function enclosingCallback(node: ts.Node) {
  for (
    let current = node.parent;
    !ts.isSourceFile(current);
    current = current.parent
  ) {
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      return current;
    }
  }
  return null;
}

function isInsideCombinatorCallback(node: ts.Node): boolean {
  const callback = enclosingCallback(node);
  return (
    callback !== null &&
    ts.isCallExpression(callback.parent) &&
    ts.isPropertyAccessExpression(callback.parent.expression) &&
    COMBINATOR_METHODS.has(callback.parent.expression.name.text)
  );
}

function isConditionalReshape(
  scope: BagScope,
  conditional: ts.ConditionalExpression
): boolean {
  return (
    isPureBagCondition(scope, conditional.condition) &&
    isInlineReshapeBranch(scope, conditional.whenTrue) &&
    isInlineReshapeBranch(scope, conditional.whenFalse) &&
    (ts.isObjectLiteralExpression(unwrapTransparent(conditional.whenTrue)) ||
      ts.isObjectLiteralExpression(unwrapTransparent(conditional.whenFalse)))
  );
}

export function classifyInlineParseReshape(
  tsArg: ts.Node | undefined,
  checker: ts.TypeChecker
) {
  if (!tsArg || isInsideCombinatorCallback(tsArg)) {
    return null;
  }
  const rawArg = unwrapTransparent(tsArg);
  const rootSource = findSingleRootSource(checker, rawArg);
  if (!rootSource) {
    return null;
  }
  const scope: BagScope = {
    checker,
    rootSymbols: new Set([rootSource.symbol]),
    fieldSymbols: new Set(),
  };
  const reshapeSource = { source: rootSource.name };
  if (
    ts.isObjectLiteralExpression(rawArg) &&
    inspectObjectLiteralBagProjection(scope, rawArg)
  ) {
    return { messageId: "inlineObjectReshape", data: reshapeSource };
  }
  if (
    ts.isConditionalExpression(rawArg) &&
    isConditionalReshape(scope, rawArg)
  ) {
    return { messageId: "inlineConditionalReshape", data: reshapeSource };
  }
  return null;
}
