import ts from "typescript";

import type { ReferenceChain } from "./narrowing-syntax.ts";
import {
  callOperands,
  enclosingContainer,
  enclosingIterationStatement,
  executesBeforeCast,
  isAssignmentTarget,
  memberKeyText,
  referenceChain,
  skipOuterParents,
  skipTransparentExpressions,
  thisContainer,
} from "./narrowing-syntax.ts";
import { proofPoint } from "./narrowing-proof.ts";
import { rootOccurrences } from "./narrowing-references.ts";

const EXECUTION_YIELDING_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.CallExpression,
  ts.SyntaxKind.NewExpression,
  ts.SyntaxKind.TaggedTemplateExpression,
  ts.SyntaxKind.AwaitExpression,
  ts.SyntaxKind.YieldExpression,
]);

type Disruption = { readonly node: ts.Node; readonly kind: string };

function sameRoot(
  checker: ts.TypeChecker,
  leftRoot: ts.Node,
  rightRoot: ts.Node
): boolean {
  if (leftRoot.kind !== rightRoot.kind) {
    return false;
  }
  if (leftRoot.kind === ts.SyntaxKind.ThisKeyword) {
    return thisContainer(leftRoot) === thisContainer(rightRoot);
  }
  const leftSymbol = checker.getSymbolAtLocation(leftRoot);
  return Boolean(
    leftSymbol && leftSymbol === checker.getSymbolAtLocation(rightRoot)
  );
}

function isChainPrefixSpelling(
  checker: ts.TypeChecker,
  node: ts.Expression,
  chain: ReferenceChain
): boolean {
  const nodeChain = referenceChain(node);
  return Boolean(
    nodeChain &&
    sameRoot(checker, nodeChain.root, chain.root) &&
    nodeChain.memberNames.length <= chain.memberNames.length &&
    nodeChain.memberNames.every(
      (memberName, index) => chain.memberNames[index] === memberName
    )
  );
}

function callHasTypePredicate(
  checker: ts.TypeChecker,
  call: ts.CallExpression
): boolean {
  const signature = checker.getResolvedSignature(call);
  return Boolean(signature && checker.getTypePredicateOfSignature(signature));
}

function mutatesChainMember(
  checker: ts.TypeChecker,
  node: ts.Node,
  chain: ReferenceChain
): boolean {
  const isDelete = ts.isDeleteExpression(node);
  const target = isDelete ? skipTransparentExpressions(node.expression) : node;
  if (
    !(isDelete || isAssignmentTarget(node)) ||
    !(
      ts.isPropertyAccessExpression(target) ||
      ts.isElementAccessExpression(target)
    )
  ) {
    return false;
  }
  const keyText = memberKeyText(target);
  return (
    (keyText === null || chain.memberNames.includes(keyText)) &&
    (isDelete || !isChainPrefixSpelling(checker, target, chain))
  );
}

function rootAssignedInNestedFunction(
  checker: ts.TypeChecker,
  chain: ReferenceChain
): ts.Node | null {
  if (chain.root.kind === ts.SyntaxKind.ThisKeyword) {
    return null;
  }
  const symbol = checker.getSymbolAtLocation(chain.root);
  const declaration = symbol?.valueDeclaration;
  if (!declaration) {
    return null;
  }
  const declarationContainer = enclosingContainer(declaration);
  return (
    rootOccurrences(checker, chain).find(
      (occurrence) =>
        isAssignmentTarget(skipOuterParents(occurrence)) &&
        enclosingContainer(occurrence) !== declarationContainer
    ) ?? null
  );
}

function windowDisruption(
  checker: ts.TypeChecker,
  chain: ReferenceChain,
  castNode: ts.AssertionExpression,
  targetType: ts.Type
): Disruption | null {
  const body = enclosingContainer(castNode);
  const loop = enclosingIterationStatement(castNode, body);
  const proof = proofPoint(checker, chain, castNode, body, targetType);
  const windowStart = proof ? proof.node.end : body.pos;
  const proofRepeatsEachIteration = Boolean(
    loop && proof && proof.node.pos >= loop.pos
  );
  const windowEnd =
    loop && !proofRepeatsEachIteration
      ? Math.max(loop.end, castNode.end)
      : castNode.end;
  let disruption: Disruption | null = null;
  const visit = (node: ts.Node): void => {
    if (
      disruption ||
      node === castNode ||
      proof?.skipped.some(
        (span) => node.pos >= span.pos && node.end <= span.end
      ) ||
      node.pos >= windowEnd ||
      node.end <= windowStart ||
      (node !== body && ts.isFunctionLike(node))
    ) {
      return;
    }
    if (
      executesBeforeCast(node, castNode, loop) &&
      node.getStart() >= windowStart &&
      EXECUTION_YIELDING_KINDS.has(node.kind) &&
      !(
        ts.isCallExpression(node) &&
        callHasTypePredicate(checker, node) &&
        callOperands(node).some((operand) =>
          isChainPrefixSpelling(checker, operand, chain)
        )
      )
    ) {
      disruption = { node, kind: "call" };
      return;
    }
    if (
      executesBeforeCast(node, castNode, loop) &&
      node.getStart() >= windowStart &&
      mutatesChainMember(checker, node, chain)
    ) {
      disruption = { node, kind: "member write" };
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(body, visit);
  return disruption;
}

export function narrowingDisruption(
  checker: ts.TypeChecker,
  operand: ts.Expression,
  castNode: ts.AssertionExpression
): Disruption | null {
  const chain = referenceChain(operand);
  if (!chain) {
    return null;
  }
  const nestedWrite = rootAssignedInNestedFunction(checker, chain);
  if (nestedWrite) {
    return { node: nestedWrite, kind: "write in a nested function" };
  }
  return chain.memberNames.length === 0
    ? null
    : windowDisruption(
        checker,
        chain,
        castNode,
        checker.getTypeFromTypeNode(castNode.type)
      );
}
