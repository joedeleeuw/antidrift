import ts from "typescript";
import { isAppeasementCastSourceType } from "./broad-input.mjs";
import {
  declaredOperandType,
  isBroadSourceType,
  narrowingDisruption,
  narrowingProvesTarget,
  proofCandidateNodes,
  skipTransparentExpressions,
} from "./cast-narrowing-proof.mjs";
import {
  findUnresolvedProvenance,
  typeContainsCompilerError,
} from "./provenance/type-resolution-provenance.ts";
import { unresolvedModuleFinding } from "./provenance/unresolved-reference.ts";

const BROAD_ESTREE_ANNOTATIONS = new Set(["TSUnknownKeyword", "TSAnyKeyword"]);
const CAST_ESTREE_TYPES = new Set(["TSAsExpression", "TSTypeAssertion"]);

const UNRESOLVED_TYPE_MESSAGE = {
  module: (finding, side) =>
    `TypeScript could not resolve module '${finding.name}', which this cast's ${side} type depends on.`,
  shorthandModule: (finding, side) =>
    `the shorthand ambient module '${finding.name}' declares no body, so everything imported from it is any, and this cast's ${side} type depends on it.`,
  name: (finding, side) =>
    `TypeScript could not resolve '${finding.name}', which this cast's ${side} type depends on.`,
  errorType: (finding, side) =>
    `the ${side} type of this cast is a compiler error type.`,
};

function unresolvedTypeMessage(finding, side) {
  return `Incomplete analysis: ${UNRESOLVED_TYPE_MESSAGE[finding.kind](finding, side)}`;
}

const UNRESOLVED_CANDIDATE_TEXT = {
  module: (finding) => `module '${finding.name}'`,
  shorthandModule: (finding) =>
    `shorthand ambient module '${finding.name}', which declares no body`,
  name: (finding) => `'${finding.name}'`,
};

function isConstAssertion({ tsAssertion }) {
  return (
    ts.isTypeReferenceNode(tsAssertion.type) &&
    ts.isIdentifier(tsAssertion.type.typeName) &&
    tsAssertion.type.typeName.text === "const"
  );
}

function lazy(compute) {
  let computed = false;
  let memoizedResult;
  return () => {
    if (!computed) {
      memoizedResult = compute();
      computed = true;
    }
    return memoizedResult;
  };
}

function provenanceFinding(castContext, rootNode, ...types) {
  const { program, typeChecker } = castContext;
  const finding = findUnresolvedProvenance(program, typeChecker, [rootNode]);
  if (finding) {
    return finding;
  }
  return types.some((type) => typeContainsCompilerError(typeChecker, type))
    ? { kind: "errorType", name: null }
    : null;
}

function unresolvedTypeRow(decisionKind, side, provenance) {
  return {
    decisionKind,
    action: "incomplete",
    rationale: `The ${side} type's provenance reaches a module or name the program cannot resolve, a shorthand ambient module, or a compiler error type, so neither a clear nor a report is decidable.`,
    matches: (castContext) => Boolean(provenance(castContext)),
    message: (castContext) =>
      unresolvedTypeMessage(provenance(castContext), side),
  };
}

function isTypePredicateParameterCast(castContext) {
  const { typeChecker, tsAssertion, tsOperand } = castContext;
  const owner = ts.findAncestor(tsAssertion.parent, ts.isFunctionLike);
  const predicate = owner?.type;
  if (
    !predicate ||
    !ts.isTypePredicateNode(predicate) ||
    !ts.isIdentifier(predicate.parameterName)
  ) {
    return false;
  }
  const predicateSymbol = typeChecker.getSymbolAtLocation(
    predicate.parameterName
  );
  const operandRoot = skipTransparentExpressions(tsOperand);
  if (!predicateSymbol || !ts.isIdentifier(operandRoot)) {
    return false;
  }
  const operandSymbol = typeChecker.getSymbolAtLocation(operandRoot);
  if (operandSymbol === predicateSymbol) {
    return true;
  }
  const declaration = operandSymbol?.valueDeclaration;
  const initializer =
    declaration &&
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer &&
    skipTransparentExpressions(declaration.initializer);
  return Boolean(
    initializer &&
    ts.isIdentifier(initializer) &&
    typeChecker.getSymbolAtLocation(initializer) === predicateSymbol
  );
}

function isChainedCast({ castNode }) {
  return (
    (CAST_ESTREE_TYPES.has(castNode.expression?.type) &&
      BROAD_ESTREE_ANNOTATIONS.has(castNode.expression.typeAnnotation?.type)) ||
    CAST_ESTREE_TYPES.has(castNode.parent?.type)
  );
}

function buildCastContext(castNode, parserServices, typeChecker) {
  const tsAssertion = parserServices.esTreeNodeToTSNodeMap.get(castNode);
  const tsOperand = tsAssertion.expression;
  const flowType = typeChecker.getTypeAtLocation(tsOperand);
  const castContext = {
    castNode,
    program: parserServices.program,
    typeChecker,
    tsAssertion,
    tsOperand,
    flowType,
    targetType: typeChecker.getTypeFromTypeNode(tsAssertion.type),
    declaredType: declaredOperandType(typeChecker, tsOperand, flowType),
  };
  castContext.sourceProvenance = lazy(() =>
    provenanceFinding(
      castContext,
      tsOperand,
      flowType,
      castContext.declaredType
    )
  );
  castContext.targetProvenance = lazy(() =>
    provenanceFinding(castContext, tsAssertion.type, castContext.targetType)
  );
  castContext.narrowingProof = lazy(() =>
    narrowingProvesTarget(typeChecker, flowType, castContext.targetType)
  );
  castContext.narrowingDisruption = lazy(() =>
    narrowingDisruption(typeChecker, tsOperand, tsAssertion)
  );
  castContext.proofCandidateProvenance = lazy(() =>
    findUnresolvedProvenance(
      parserServices.program,
      typeChecker,
      proofCandidateNodes(typeChecker, tsOperand, tsAssertion)
    )
  );
  return castContext;
}

const CAST_DECISION_TABLE = [
  {
    decisionKind: "const_assertion",
    action: "clear",
    rationale:
      "`as const` asks TypeScript for the operand's own literal type and asserts no contract.",
    matches: isConstAssertion,
  },
  {
    decisionKind: "non_narrowing_target",
    action: "clear",
    rationale:
      "The target is any or unknown and claims nothing beyond the source.",
    matches: (castContext) =>
      isAppeasementCastSourceType(castContext.targetType),
  },
  {
    decisionKind: "double_cast_chain",
    action: "clear",
    rationale:
      "A nested assertion chain is owned by no-unsafe-cast-chain, not this rule.",
    matches: isChainedCast,
  },
  {
    decisionKind: "type_predicate_implementation",
    action: "clear",
    rationale:
      "A type predicate or assertion function inspecting its own parameter implements the boundary that proves the type.",
    matches: isTypePredicateParameterCast,
  },
  unresolvedTypeRow("unresolved_source_type", "source", (castContext) =>
    castContext.sourceProvenance()
  ),
  {
    decisionKind: "typed_source",
    action: "clear",
    rationale:
      "The operand's declared type, before control-flow narrowing, is neither any, unknown nor an unconstrained type parameter, so the cast does not force a broad value.",
    matches: ({ typeChecker, declaredType }) =>
      !isBroadSourceType(typeChecker, declaredType),
  },
  unresolvedTypeRow("unresolved_target_type", "target", (castContext) =>
    castContext.targetProvenance()
  ),
  {
    decisionKind: "unstable_narrowing_proof",
    action: "incomplete",
    rationale:
      "TypeScript narrowed the value to a type assignable to the target, but a call, await, closure assignment or alias write that TypeScript's narrowing ignores may change it before the cast.",
    matches: (castContext) =>
      castContext.narrowingProof() &&
      Boolean(castContext.narrowingDisruption()),
    message: (castContext) => {
      const { node, kind } = castContext.narrowingDisruption();
      const { line } = node
        .getSourceFile()
        .getLineAndCharacterOfPosition(node.getStart());
      return `Incomplete analysis: a checker-visible proof narrows this value, but a ${kind} at line ${line + 1} may change it before the cast.`;
    },
  },
  {
    decisionKind: "checker_narrowing_proof",
    action: "clear",
    rationale:
      "A checker-visible proof (type predicate branch, asserts call, instanceof, typeof, discriminant or decoder result) narrowed the value to a type assignable to the target, with no any type argument acting as a wildcard. A value narrowed to an object satisfies a target that only claims unknown-valued keys.",
    matches: (castContext) => castContext.narrowingProof(),
  },
  {
    decisionKind: "unresolved_proof_candidate",
    action: "incomplete",
    rationale:
      "An expression that tests this value (a call, instanceof or comparison) depends on a module or name the program cannot resolve, so a proof TypeScript cannot see may exist.",
    matches: (castContext) => Boolean(castContext.proofCandidateProvenance()),
    message: (castContext) => {
      const finding = castContext.proofCandidateProvenance();
      return `Incomplete analysis: a test of this value depends on unresolved ${UNRESOLVED_CANDIDATE_TEXT[finding.kind](finding)}, so TypeScript cannot see whether it proves the cast.`;
    },
  },
  {
    decisionKind: "broad_source_to_unproven_contract",
    action: "report",
    rationale:
      "An any or unknown value is cast to a contract that no checker-visible proof establishes.",
    matches: () => true,
    message: () =>
      "This cast forces an unproven value into a named contract. Declare the input type or use a type guard before assigning it.",
  },
];

export function inspectAppeasementCast(castNode, parserServices, typeChecker) {
  const castContext = buildCastContext(castNode, parserServices, typeChecker);
  const entry = CAST_DECISION_TABLE.find((tableEntry) =>
    tableEntry.matches(castContext)
  );
  return {
    action: entry.action,
    decisionKind: entry.decisionKind,
    message: entry.message ? entry.message(castContext) : null,
  };
}

export function inspectImportSite(importNode, parserServices, typeChecker) {
  const finding = unresolvedModuleFinding(
    typeChecker,
    parserServices.esTreeNodeToTSNodeMap.get(importNode)
  );
  return finding?.kind === "module"
    ? `Incomplete analysis: TypeScript could not resolve module '${finding.name}', so casts that depend on it cannot be decided.`
    : null;
}
