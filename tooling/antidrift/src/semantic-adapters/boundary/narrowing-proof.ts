import ts from "typescript";

import type {
  chainOccurrence,
  GoverningConstruct,
  ReferenceChain,
} from "./narrowing-syntax.ts";
import {
  enclosingContainer,
  enclosingIterationStatement,
  EQUALITY_OPERATOR_KINDS,
  executesBeforeCast,
  governingCondition,
  governingConstruct,
  isEarlyExitGuard,
  isGoverningConstruct,
  isNullishLiteral,
  isWithin,
  referenceChain,
  skipOuterParents,
  skipTransparentExpressions,
  testConsumers,
} from "./narrowing-syntax.ts";
import {
  claimsOnlyUnknownValuedKeys,
  declaredOperandType,
  narrowingProvesTarget,
} from "./narrowing-types.ts";

import { referenceOccurrences } from "./narrowing-references.ts";

const OBJECT_YIELD = Symbol("object");

type TestYield = ts.Type | typeof OBJECT_YIELD;

type PredicateYield = { readonly type: ts.Type; readonly asserts: boolean };

type ProofSpan = { readonly pos: number; readonly end: number };

type Proof = { readonly node: ts.Node; readonly skipped: readonly ProofSpan[] };

type ConditionProof = {
  readonly anchor: ts.Node;
  readonly skipped: readonly ProofSpan[];
};

type ConditionTest = {
  readonly negated: boolean;
  readonly established: boolean;
  readonly complement: boolean;
};

type Test = {
  readonly node: ts.Node;
  readonly yielded: TestYield;
  readonly negated: boolean;
  readonly complement?: ts.Type | undefined;
};

type ReferenceOccurrence = ReturnType<typeof chainOccurrence>[number];

type TypeofYieldReader = (checker: ts.TypeChecker) => TestYield;

const TYPEOF_YIELDS: ReadonlyMap<string, TypeofYieldReader> = new Map<
  string,
  TypeofYieldReader
>([
  ["string", (checker) => checker.getStringType()],
  ["number", (checker) => checker.getNumberType()],
  ["boolean", (checker) => checker.getBooleanType()],
  ["bigint", (checker) => checker.getBigIntType()],
  ["symbol", (checker) => checker.getESSymbolType()],
  ["undefined", (checker) => checker.getUndefinedType()],
  ["object", () => OBJECT_YIELD],
]);

const NEGATED_EQUALITY_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);

function navigateMembers(
  checker: ts.TypeChecker,
  type: TestYield,
  remainder: readonly string[]
): TestYield | null {
  let current: TestYield | null = type;
  for (const memberName of remainder) {
    if (!current || current === OBJECT_YIELD) {
      return null;
    }
    const property = checker.getPropertyOfType(current, memberName);
    current = property
      ? checker.getTypeOfSymbol(property)
      : (checker.getIndexTypeOfType(current, ts.IndexKind.String) ?? null);
  }
  return current;
}

function predicateYield(
  checker: ts.TypeChecker,
  call: ts.CallExpression,
  tested: ts.Expression
): PredicateYield | null {
  const signature = checker.getResolvedSignature(call);
  const predicate = signature && checker.getTypePredicateOfSignature(signature);
  if (!predicate || !predicate.type) {
    return null;
  }
  let subject: ts.Expression | undefined;
  if (
    predicate.kind === ts.TypePredicateKind.Identifier ||
    predicate.kind === ts.TypePredicateKind.AssertsIdentifier
  ) {
    subject = call.arguments[predicate.parameterIndex];
  } else if (ts.isPropertyAccessExpression(call.expression)) {
    subject = call.expression.expression;
  }
  const asserts =
    predicate.kind === ts.TypePredicateKind.AssertsIdentifier ||
    predicate.kind === ts.TypePredicateKind.AssertsThis;
  return subject &&
    skipOuterParents(skipTransparentExpressions(subject)) === tested
    ? { type: predicate.type, asserts }
    : null;
}

function nonNullableDeclaredType(
  checker: ts.TypeChecker,
  tested: ts.Expression
): ts.Type {
  return checker.getNonNullableType(
    declaredOperandType(checker, tested, checker.getTypeAtLocation(tested))
  );
}

function binaryTest(
  checker: ts.TypeChecker,
  tested: ts.Expression,
  comparison: ts.BinaryExpression
): Test | null {
  const operatorKind = comparison.operatorToken.kind;
  if (
    operatorKind === ts.SyntaxKind.InstanceOfKeyword &&
    comparison.left === tested
  ) {
    const constructSignature = checker
      .getTypeAtLocation(comparison.right)
      .getConstructSignatures()[0];
    return constructSignature
      ? {
          node: comparison,
          yielded: checker.getReturnTypeOfSignature(constructSignature),
          negated: false,
        }
      : null;
  }
  if (operatorKind === ts.SyntaxKind.InKeyword && comparison.right === tested) {
    return { node: comparison, yielded: OBJECT_YIELD, negated: false };
  }
  if (EQUALITY_OPERATOR_KINDS.has(operatorKind)) {
    const other =
      comparison.left === tested ? comparison.right : comparison.left;
    return isNullishLiteral(other)
      ? {
          node: comparison,
          yielded: nonNullableDeclaredType(checker, tested),
          negated: !NEGATED_EQUALITY_KINDS.has(operatorKind),
          complement:
            other.kind === ts.SyntaxKind.NullKeyword
              ? checker.getNullType()
              : checker.getUndefinedType(),
        }
      : null;
  }
  if (
    operatorKind === ts.SyntaxKind.AmpersandAmpersandToken ||
    operatorKind === ts.SyntaxKind.BarBarToken
  ) {
    return {
      node: tested,
      yielded: nonNullableDeclaredType(checker, tested),
      negated: false,
    };
  }
  return null;
}

function testOf(checker: ts.TypeChecker, tested: ts.Expression): Test | null {
  const parent = tested.parent;
  if (ts.isCallExpression(parent)) {
    const yielded = predicateYield(checker, parent, tested);
    return yielded
      ? { node: parent, yielded: yielded.type, negated: false }
      : null;
  }
  if (ts.isTypeOfExpression(parent) && ts.isBinaryExpression(parent.parent)) {
    const comparison = parent.parent;
    const other =
      comparison.left === parent ? comparison.right : comparison.left;
    const form =
      EQUALITY_OPERATOR_KINDS.has(comparison.operatorToken.kind) &&
      ts.isStringLiteralLike(other)
        ? TYPEOF_YIELDS.get(other.text)
        : undefined;
    return form
      ? {
          node: comparison,
          yielded: form(checker),
          negated: NEGATED_EQUALITY_KINDS.has(comparison.operatorToken.kind),
        }
      : null;
  }
  if (ts.isBinaryExpression(parent)) {
    return binaryTest(checker, tested, parent);
  }
  if (
    (ts.isPrefixUnaryExpression(parent) &&
      parent.operator === ts.SyntaxKind.ExclamationToken) ||
    isGoverningConstruct(parent)
  ) {
    return {
      node: tested,
      yielded: nonNullableDeclaredType(checker, tested),
      negated: false,
    };
  }
  return null;
}

function conditionTests(
  checker: ts.TypeChecker,
  chain: ReferenceChain,
  condition: ts.Expression,
  castNode: ts.AssertionExpression,
  targetType: ts.Type
): Map<ts.Node, ConditionTest> {
  const tests = new Map<ts.Node, ConditionTest>();
  for (const occurrence of referenceOccurrences(checker, chain)) {
    const tested = skipOuterParents(occurrence.node);
    if (!isWithin(tested, condition) || tested.end > castNode.getStart()) {
      continue;
    }
    const test = testOf(checker, tested);
    if (!test) {
      continue;
    }
    const proves = (yielded: TestYield | null | undefined): boolean => {
      const established = yielded
        ? navigateMembers(checker, yielded, occurrence.remainder)
        : null;
      return Boolean(
        established && yieldProvesTarget(checker, established, targetType)
      );
    };
    tests.set(test.node, {
      negated: test.negated,
      established: proves(test.yielded),
      complement: proves(test.complement ?? null),
    });
  }
  return tests;
}

function conditionProof(
  node: ts.Expression,
  outcome: boolean,
  tests: ReadonlyMap<ts.Node, ConditionTest>
): ConditionProof | null {
  const expression = skipTransparentExpressions(node);
  const test = tests.get(expression);
  if (test) {
    const established =
      outcome !== test.negated ? test.established : test.complement;
    return established ? { anchor: expression, skipped: [] } : null;
  }
  if (
    ts.isPrefixUnaryExpression(expression) &&
    expression.operator === ts.SyntaxKind.ExclamationToken
  ) {
    return conditionProof(expression.operand, !outcome, tests);
  }
  if (!ts.isBinaryExpression(expression)) {
    return null;
  }
  const operatorKind = expression.operatorToken.kind;
  const conjunction = operatorKind === ts.SyntaxKind.AmpersandAmpersandToken;
  if (!conjunction && operatorKind !== ts.SyntaxKind.BarBarToken) {
    return null;
  }
  const left = conditionProof(expression.left, outcome, tests);
  const right = conditionProof(expression.right, outcome, tests);
  if (conjunction === outcome) {
    return right ?? left;
  }
  if (!left || !right) {
    return null;
  }
  return {
    anchor: left.anchor,
    skipped: [
      ...left.skipped,
      ...right.skipped,
      { pos: expression.right.pos, end: right.anchor.end },
    ],
  };
}

function proofWithinCondition(
  condition: ts.Expression,
  castNode: ts.Node,
  tests: ReadonlyMap<ts.Node, ConditionTest>
): ConditionProof | null {
  let current: ts.Node = castNode;
  while (current !== condition) {
    const parent = current.parent;
    if (ts.isBinaryExpression(parent) && parent.right === current) {
      const operatorKind = parent.operatorToken.kind;
      let proof: ConditionProof | null = null;
      if (operatorKind === ts.SyntaxKind.AmpersandAmpersandToken) {
        proof = conditionProof(parent.left, true, tests);
      } else if (operatorKind === ts.SyntaxKind.BarBarToken) {
        proof = conditionProof(parent.left, false, tests);
      }
      if (proof) {
        return proof;
      }
    }
    if (ts.isConditionalExpression(parent) && parent.condition !== current) {
      const proof = conditionProof(
        parent.condition,
        parent.whenTrue === current,
        tests
      );
      if (proof) {
        return proof;
      }
    }
    current = parent;
  }
  return null;
}

function outcomeReachingCast(
  governing: GoverningConstruct,
  castNode: ts.AssertionExpression
): boolean | null {
  if (ts.isIfStatement(governing)) {
    if (isWithin(castNode, governing.thenStatement)) {
      return true;
    }
    return isWithin(castNode, governing.elseStatement) ? false : null;
  }
  if (ts.isConditionalExpression(governing)) {
    if (isWithin(castNode, governing.whenTrue)) {
      return true;
    }
    return isWithin(castNode, governing.whenFalse) ? false : null;
  }
  return ts.isSwitchStatement(governing) ? null : true;
}

function yieldProvesTarget(
  checker: ts.TypeChecker,
  yielded: TestYield,
  targetType: ts.Type
): boolean {
  if (yielded === OBJECT_YIELD) {
    return (
      !checker.isArrayLikeType(targetType) &&
      claimsOnlyUnknownValuedKeys(checker, targetType)
    );
  }
  return narrowingProvesTarget(checker, yielded, targetType);
}

function assertionProof(
  checker: ts.TypeChecker,
  occurrence: ReferenceOccurrence,
  governing: ts.ExpressionStatement,
  castNode: ts.AssertionExpression,
  targetType: ts.Type
): Proof | null {
  const tested = skipOuterParents(occurrence.node);
  const call = skipTransparentExpressions(governing.expression);
  const yielded =
    ts.isCallExpression(call) && predicateYield(checker, call, tested);
  const established =
    yielded &&
    yielded.asserts &&
    navigateMembers(checker, yielded.type, occurrence.remainder);
  return established &&
    yieldProvesTarget(checker, established, targetType) &&
    governing.end <= castNode.getStart() &&
    isWithin(castNode, governing.parent)
    ? { node: governing, skipped: [] }
    : null;
}

function conditionGovernedProof(
  checker: ts.TypeChecker,
  chain: ReferenceChain,
  governing: GoverningConstruct,
  castNode: ts.AssertionExpression,
  targetType: ts.Type
): Proof | null {
  const condition = governingCondition(governing);
  if (!condition) {
    return null;
  }
  const tests = conditionTests(checker, chain, condition, castNode, targetType);
  if (!tests.size) {
    return null;
  }
  if (isWithin(castNode, condition)) {
    const proof = proofWithinCondition(condition, castNode, tests);
    return proof ? { node: proof.anchor, skipped: proof.skipped } : null;
  }
  if (governing.pos <= castNode.pos && governing.end >= castNode.end) {
    const required = outcomeReachingCast(governing, castNode);
    const proof =
      required !== null && conditionProof(condition, required, tests);
    return proof ? { node: proof.anchor, skipped: proof.skipped } : null;
  }
  if (!isEarlyExitGuard(governing, castNode)) {
    return null;
  }
  const proof = conditionProof(condition, false, tests);
  return proof
    ? {
        node: proof.anchor,
        skipped: [...proof.skipped, governing.thenStatement],
      }
    : null;
}

export function proofPoint(
  checker: ts.TypeChecker,
  chain: ReferenceChain,
  castNode: ts.AssertionExpression,
  body: ts.Node,
  targetType: ts.Type
): Proof | null {
  let latest: Proof | null = null;
  const governed = new Set<ts.Node>();
  const consider = (proof: Proof | null): void => {
    if (proof && (!latest || proof.node.end > latest.node.end)) {
      latest = proof;
    }
  };
  for (const occurrence of referenceOccurrences(checker, chain)) {
    const tested = skipOuterParents(occurrence.node);
    const governing = governingConstruct(tested);
    if (!governing || enclosingContainer(tested) !== body) {
      continue;
    }
    if (ts.isExpressionStatement(governing)) {
      consider(
        assertionProof(checker, occurrence, governing, castNode, targetType)
      );
      continue;
    }
    if (governed.has(governing)) {
      continue;
    }
    governed.add(governing);
    consider(
      conditionGovernedProof(checker, chain, governing, castNode, targetType)
    );
  }
  return latest;
}

export function proofCandidateNodes(
  checker: ts.TypeChecker,
  operand: ts.Expression,
  castNode: ts.AssertionExpression
): ts.Node[] {
  const chain = referenceChain(operand);
  if (!chain) {
    return [];
  }
  const body = enclosingContainer(castNode);
  const loop = enclosingIterationStatement(castNode, body);
  return referenceOccurrences(checker, chain)
    .map((occurrence) => skipOuterParents(occurrence.node))
    .filter(
      (tested) =>
        executesBeforeCast(tested, castNode, loop) &&
        enclosingContainer(tested) === body
    )
    .flatMap(testConsumers);
}
