import ts from "typescript";

import { isAppeasementCastSourceType } from "./broad-input-type.ts";
import type { TypeServices } from "../kernel/rule-kernel.ts";
import { isSyntaxTypeIn, syntaxField } from "../kernel/syntax-node.ts";
import { narrowingDisruption } from "./narrowing-disruption.ts";
import { proofCandidateNodes } from "./narrowing-proof.ts";
import { skipTransparentExpressions } from "./narrowing-syntax.ts";
import {
  declaredOperandType,
  isBroadSourceType,
  narrowingProvesTarget,
} from "./narrowing-types.ts";
import {
  findUnresolvedProvenance,
  typeContainsCompilerError,
} from "../provenance/type-resolution-provenance.ts";
import { unresolvedModuleFinding } from "../provenance/unresolved-reference.ts";
import type { UnresolvedFinding } from "../provenance/unresolved-reference.ts";

const BROAD_ESTREE_ANNOTATIONS: ReadonlySet<string> = new Set([
  "TSUnknownKeyword",
  "TSAnyKeyword",
]);

const CAST_ESTREE_TYPES: ReadonlySet<string> = new Set([
  "TSAsExpression",
  "TSTypeAssertion",
]);

type CastProvenance =
  | UnresolvedFinding
  | { readonly kind: "errorType"; readonly name: null };

type CastAction = "clear" | "incomplete" | "report";

type CastContext = {
  readonly castNode: unknown;
  readonly typeChecker: ts.TypeChecker;
  readonly tsAssertion: ts.AssertionExpression;
  readonly tsOperand: ts.Expression;
  readonly flowType: ts.Type;
  readonly targetType: ts.Type;
  readonly declaredType: ts.Type;
  readonly sourceProvenance: () => CastProvenance | null;
  readonly targetProvenance: () => CastProvenance | null;
  readonly narrowingProof: () => boolean;
  readonly disruption: () => {
    readonly node: ts.Node;
    readonly kind: string;
  } | null;
  readonly proofCandidateProvenance: () => UnresolvedFinding | null;
};

type CastDecisionRow = {
  readonly decisionKind: string;
  readonly action: CastAction;
  readonly rationale: string;
  readonly matches: (castContext: CastContext) => boolean;
  readonly message: ((castContext: CastContext) => string) | null;
};

type CastDecision = {
  readonly action: CastAction;
  readonly decisionKind: string;
  readonly message: string | null;
};

const UNRESOLVED_TYPE_MESSAGE = {
  module: (finding, side) =>
    `TypeScript could not resolve module '${finding.name}', which this cast's ${side} type depends on.`,
  shorthandModule: (finding, side) =>
    `the shorthand ambient module '${finding.name}' declares no body, so everything imported from it is any, and this cast's ${side} type depends on it.`,
  name: (finding, side) =>
    `TypeScript could not resolve '${finding.name}', which this cast's ${side} type depends on.`,
  errorType: (_, side) =>
    `the ${side} type of this cast is a compiler error type.`,
} satisfies Record<
  CastProvenance["kind"],
  (finding: CastProvenance, side: string) => string
>;

const UNRESOLVED_CANDIDATE_TEXT = {
  module: (finding) => `module '${finding.name}'`,
  shorthandModule: (finding) =>
    `shorthand ambient module '${finding.name}', which declares no body`,
  name: (finding) => `'${finding.name}'`,
} satisfies Record<
  UnresolvedFinding["kind"],
  (finding: UnresolvedFinding) => string
>;

function unresolvedTypeMessage(finding: CastProvenance, side: string): string {
  return `Incomplete analysis: ${UNRESOLVED_TYPE_MESSAGE[finding.kind](finding, side)}`;
}

function requireMappedNode(
  services: TypeServices,
  node: unknown,
  description: string
): ts.Node {
  const mapped = services.esTreeNodeToTSNodeMap.get(node);
  if (!mapped) {
    throw new TypeError(
      `no-appeasement-cast: the ${description} node has no TypeScript mapping`
    );
  }
  return mapped;
}

function requireAssertionExpression(
  services: TypeServices,
  castNode: unknown
): ts.AssertionExpression {
  const mapped = requireMappedNode(services, castNode, "cast assertion");
  if (!ts.isAssertionExpression(mapped)) {
    throw new TypeError(
      "no-appeasement-cast: the cast assertion node is not a TypeScript assertion expression"
    );
  }
  return mapped;
}

function isConstAssertion(castContext: CastContext): boolean {
  const { tsAssertion } = castContext;
  return (
    ts.isTypeReferenceNode(tsAssertion.type) &&
    ts.isIdentifier(tsAssertion.type.typeName) &&
    tsAssertion.type.typeName.text === "const"
  );
}

function lazy<T>(compute: () => T): () => T {
  let memoized: { value: T } | undefined;
  return () => {
    memoized ??= { value: compute() };
    return memoized.value;
  };
}

function provenanceFinding(
  program: ts.Program,
  checker: ts.TypeChecker,
  rootNode: ts.Node,
  ...types: readonly ts.Type[]
): CastProvenance | null {
  const finding = findUnresolvedProvenance(program, checker, [rootNode]);
  if (finding) {
    return finding;
  }
  return types.some((type) => typeContainsCompilerError(checker, type))
    ? { kind: "errorType", name: null }
    : null;
}

function unresolvedTypeRow(
  decisionKind: string,
  side: string,
  provenance: (castContext: CastContext) => CastProvenance | null
): CastDecisionRow {
  return {
    decisionKind,
    action: "incomplete",
    rationale: `The ${side} type's provenance reaches a module or name the program cannot resolve, a shorthand ambient module, or a compiler error type, so neither a clear nor a report is decidable.`,
    matches: (castContext) => Boolean(provenance(castContext)),
    message: (castContext) => {
      const finding = provenance(castContext);
      if (!finding) {
        throw new TypeError(
          "no-appeasement-cast: an unresolved-type row decided without a provenance finding"
        );
      }
      return unresolvedTypeMessage(finding, side);
    },
  };
}

function isTypePredicateParameterCast(castContext: CastContext): boolean {
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
  let initializer: ts.Expression | undefined;
  if (
    declaration &&
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer
  ) {
    initializer = skipTransparentExpressions(declaration.initializer);
  }
  return Boolean(
    initializer &&
    ts.isIdentifier(initializer) &&
    typeChecker.getSymbolAtLocation(initializer) === predicateSymbol
  );
}

function isChainedCast(castContext: CastContext): boolean {
  const expression = syntaxField(castContext.castNode, "expression");
  if (
    isSyntaxTypeIn(expression, CAST_ESTREE_TYPES) &&
    isSyntaxTypeIn(
      syntaxField(expression, "typeAnnotation"),
      BROAD_ESTREE_ANNOTATIONS
    )
  ) {
    return true;
  }
  return isSyntaxTypeIn(
    syntaxField(castContext.castNode, "parent"),
    CAST_ESTREE_TYPES
  );
}

function buildCastContext(
  castNode: unknown,
  services: TypeServices,
  typeChecker: ts.TypeChecker
): CastContext {
  const tsAssertion = requireAssertionExpression(services, castNode);
  const tsOperand = tsAssertion.expression;
  const flowType = typeChecker.getTypeAtLocation(tsOperand);
  const targetType = typeChecker.getTypeFromTypeNode(tsAssertion.type);
  const declaredType = declaredOperandType(typeChecker, tsOperand, flowType);
  return {
    castNode,
    typeChecker,
    tsAssertion,
    tsOperand,
    flowType,
    targetType,
    declaredType,
    sourceProvenance: lazy(() =>
      provenanceFinding(
        services.program,
        typeChecker,
        tsOperand,
        flowType,
        declaredType
      )
    ),
    targetProvenance: lazy(() =>
      provenanceFinding(
        services.program,
        typeChecker,
        tsAssertion.type,
        targetType
      )
    ),
    narrowingProof: lazy(() =>
      narrowingProvesTarget(typeChecker, flowType, targetType)
    ),
    disruption: lazy(() =>
      narrowingDisruption(typeChecker, tsOperand, tsAssertion)
    ),
    proofCandidateProvenance: lazy(() =>
      findUnresolvedProvenance(services.program, typeChecker, [
        ...proofCandidateNodes(typeChecker, tsOperand, tsAssertion),
      ])
    ),
  };
}

const CAST_DECISION_TABLE = [
  {
    decisionKind: "const_assertion",
    action: "clear",
    rationale:
      "`as const` asks TypeScript for the operand's own literal type and asserts no contract.",
    matches: isConstAssertion,
    message: null,
  },
  {
    decisionKind: "non_narrowing_target",
    action: "clear",
    rationale:
      "The target is any or unknown and claims nothing beyond the source.",
    matches: (castContext: CastContext) =>
      isAppeasementCastSourceType(castContext.targetType),
    message: null,
  },
  {
    decisionKind: "double_cast_chain",
    action: "clear",
    rationale:
      "A nested assertion chain is owned by no-unsafe-cast-chain, not this rule.",
    matches: isChainedCast,
    message: null,
  },
  {
    decisionKind: "type_predicate_implementation",
    action: "clear",
    rationale:
      "A type predicate or assertion function inspecting its own parameter implements the boundary that proves the type.",
    matches: isTypePredicateParameterCast,
    message: null,
  },
  unresolvedTypeRow("unresolved_source_type", "source", (castContext) =>
    castContext.sourceProvenance()
  ),
  {
    decisionKind: "typed_source",
    action: "clear",
    rationale:
      "The operand's declared type, before control-flow narrowing, is neither any, unknown nor an unconstrained type parameter, so the cast does not force a broad value.",
    matches: (castContext: CastContext) =>
      !isBroadSourceType(castContext.typeChecker, castContext.declaredType),
    message: null,
  },
  unresolvedTypeRow("unresolved_target_type", "target", (castContext) =>
    castContext.targetProvenance()
  ),
  {
    decisionKind: "unstable_narrowing_proof",
    action: "incomplete",
    rationale:
      "TypeScript narrowed the value to a type assignable to the target, but a call, await, closure assignment or alias write that TypeScript's narrowing ignores may change it before the cast.",
    matches: (castContext: CastContext) =>
      castContext.narrowingProof() && Boolean(castContext.disruption()),
    message: (castContext: CastContext) => {
      const disruption = castContext.disruption();
      if (!disruption) {
        throw new TypeError(
          "no-appeasement-cast: an unstable-narrowing row decided without a disruption"
        );
      }
      const { node, kind } = disruption;
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
    matches: (castContext: CastContext) => castContext.narrowingProof(),
    message: null,
  },
  {
    decisionKind: "unresolved_proof_candidate",
    action: "incomplete",
    rationale:
      "An expression that tests this value (a call, instanceof or comparison) depends on a module or name the program cannot resolve, so a proof TypeScript cannot see may exist.",
    matches: (castContext: CastContext) =>
      Boolean(castContext.proofCandidateProvenance()),
    message: (castContext: CastContext) => {
      const finding = castContext.proofCandidateProvenance();
      if (!finding) {
        throw new TypeError(
          "no-appeasement-cast: an unresolved-proof-candidate row decided without a finding"
        );
      }
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
] satisfies readonly CastDecisionRow[];

export function inspectAppeasementCast(
  castNode: unknown,
  services: TypeServices,
  typeChecker: ts.TypeChecker
): CastDecision {
  const castContext = buildCastContext(castNode, services, typeChecker);
  const entry = CAST_DECISION_TABLE.find((row) => row.matches(castContext));
  if (!entry) {
    throw new TypeError("no-appeasement-cast: no cast decision row matched");
  }
  return {
    action: entry.action,
    decisionKind: entry.decisionKind,
    message: entry.message ? entry.message(castContext) : null,
  };
}

export function inspectImportSite(
  importNode: unknown,
  services: TypeServices,
  typeChecker: ts.TypeChecker
): string | null {
  const finding = unresolvedModuleFinding(
    typeChecker,
    requireMappedNode(services, importNode, "import site")
  );
  return finding?.kind === "module"
    ? `Incomplete analysis: TypeScript could not resolve module '${finding.name}', so casts that depend on it cannot be decided.`
    : null;
}
