import { relative } from "node:path";
import ts from "typescript";

import { boundaryObservations } from "../boundary/boundary-observations.ts";
import { GuardReader, PathProjection } from "../boundary/widening-paths.ts";
import { isTypeReference } from "../kernel/typescript-internals.ts";
import { typeContainsCompilerError } from "../provenance/type-resolution-provenance.ts";
import { RecoveryReader } from "../boundary/widening-recoveries.ts";
import type {
  OperandRelevance,
  Recovery,
} from "../boundary/widening-recoveries.ts";
import { SlotTracer } from "../boundary/widening-trace.ts";
import type { Origin, Slot } from "../boundary/widening-trace.ts";
import { CandidateEvaluation } from "./widening-evaluation.ts";
import type { Candidate } from "./widening-evaluation.ts";
import { WideningMessage } from "./widening-message.ts";
import type { Owner } from "./widening-message.ts";
import { SlotProducers } from "./widening-producers.ts";
import type { Producer } from "./widening-producers.ts";

export type WideningFinding = {
  readonly anchor: ts.Node;
  readonly data: Readonly<Record<string, string>>;
};

export type WideningOptions = {
  readonly cwd: string;
  readonly testFile: boolean;
  readonly observe: ((observation: object) => void) | null;
};

type Decision =
  | { readonly kind: "report"; readonly producers: readonly Producer[] }
  | { readonly kind: "clear" }
  | {
      readonly kind: "incomplete";
      readonly cause: string;
      readonly bound: { readonly bound: string; readonly limit: number } | null;
    };

const LOCAL_EDGES: ReadonlySet<Slot["kind"]> = new Set(["binding", "cast"]);

const CLEAR: Decision = { kind: "clear" };

const CONTAINER_FLAGS =
  ts.TypeFlags.Object | ts.TypeFlags.Intersection | ts.TypeFlags.Any;

const TYPE_VARIABLE_FLAGS =
  ts.TypeFlags.TypeParameter |
  ts.TypeFlags.IndexedAccess |
  ts.TypeFlags.Conditional |
  ts.TypeFlags.Substitution |
  ts.TypeFlags.Index;

const TYPE_VARIABLE_DEPTH = 4;

function incomplete(
  cause: string,
  bound: { readonly bound: string; readonly limit: number } | null = null
): Decision {
  return { kind: "incomplete", cause, bound };
}

function typeParameterNames(node: ts.Node): ReadonlySet<string> {
  const names = new Set<string>();
  ts.findAncestor(node, (ancestor) => {
    if (
      ts.isFunctionLike(ancestor) ||
      ts.isClassLike(ancestor) ||
      ts.isInterfaceDeclaration(ancestor) ||
      ts.isTypeAliasDeclaration(ancestor)
    ) {
      for (const parameter of ancestor.typeParameters ?? []) {
        names.add(parameter.name.text);
      }
    }
    return false;
  });
  return names;
}

function mentionsTypeParameter(
  node: ts.Node,
  names: ReadonlySet<string>
): boolean {
  if (node.kind === ts.SyntaxKind.ThisType) {
    return true;
  }
  if (
    ts.isTypeReferenceNode(node) &&
    ts.isIdentifier(node.typeName) &&
    names.has(node.typeName.text)
  ) {
    return true;
  }
  return Boolean(
    ts.forEachChild(
      node,
      (child) => mentionsTypeParameter(child, names) || undefined
    )
  );
}

/** Whether a type is, or is built from, a type variable: generic re-instantiation is deferred. */
function mentionsTypeVariable(
  checker: ts.TypeChecker,
  type: ts.Type,
  depth = 0
): boolean {
  if ((type.flags & TYPE_VARIABLE_FLAGS) !== 0) {
    return true;
  }
  if (depth >= TYPE_VARIABLE_DEPTH) {
    return false;
  }
  const parts = [
    ...(type.isUnionOrIntersection() ? type.types : []),
    ...(type.aliasTypeArguments ?? []),
    ...(isTypeReference(type) ? checker.getTypeArguments(type) : []),
  ];
  return parts.some((part) => mentionsTypeVariable(checker, part, depth + 1));
}

function predicateParameter(slot: Slot): boolean {
  const declaration = slot.declaration;
  if (!ts.isParameter(declaration) || !slot.binding) {
    return false;
  }
  const returned = declaration.parent.type;
  return Boolean(
    returned &&
    ts.isTypePredicateNode(returned) &&
    ts.isIdentifier(returned.parameterName) &&
    returned.parameterName.text === slot.binding.text
  );
}

function lineOf(node: ts.Node): number {
  const sourceFile = node.getSourceFile();
  return (
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
  );
}

function sharesLoop(left: ts.Node, right: ts.Node, scope: ts.Node): boolean {
  const loop = ts.findAncestor(left, (node) =>
    node === scope ? "quit" : ts.isIterationStatement(node, false)
  );
  return Boolean(loop && right.pos >= loop.pos && right.end <= loop.end);
}

/**
 * Round-trip widening: a slot's declared contract drops part of the type its
 * producers supply, and a recovery downstream re-establishes it. A recovery
 * counts only when every visible producer already satisfies it (structurally)
 * while the slot's own type does not; anything unresolved is incomplete.
 */
export class RoundTripWidening {
  readonly #checker: ts.TypeChecker;
  readonly #options: WideningOptions;
  readonly #recoveries: RecoveryReader;
  readonly #tracer: SlotTracer;
  readonly #guards: GuardReader;
  readonly #paths: PathProjection;
  readonly #producers: SlotProducers;
  readonly #message: WideningMessage;
  readonly #candidates = new Map<Slot, Candidate[]>();
  readonly #origins = new Map<ts.Node, Origin | null>();
  readonly #declared = new Map<ts.Node, readonly ts.Type[]>();
  readonly #relevance: OperandRelevance;

  constructor(program: ts.Program, options: WideningOptions) {
    const checker = program.getTypeChecker();
    this.#checker = checker;
    this.#options = options;
    this.#recoveries = new RecoveryReader(checker);
    this.#tracer = new SlotTracer(checker);
    this.#guards = new GuardReader(checker, this.#tracer);
    this.#paths = new PathProjection(checker);
    this.#producers = new SlotProducers(program, checker);
    this.#message = new WideningMessage(program, checker, options.cwd);
    this.#relevance = {
      traces: (operand) => Boolean(this.#origin(operand)),
      declaresAny: (operand) =>
        this.#declaredAt(operand).some(
          (member) => (member.flags & ts.TypeFlags.Any) !== 0
        ),
      declaresUnion: (operand) =>
        this.#declaredAt(operand).filter(
          (member) => (member.flags & ts.TypeFlags.Object) !== 0
        ).length > 1,
    };
  }

  inspect(node: ts.Node): void {
    for (const recovery of this.#recoveries.at(node, this.#relevance)) {
      const origin = this.#origin(recovery.operand);
      if (!origin) {
        continue;
      }
      const candidates = this.#candidates.get(origin.slot) ?? [];
      candidates.push({ recovery, origin });
      this.#candidates.set(origin.slot, candidates);
    }
  }

  /** The slot's declared type at the operand's path, before any flow narrowing. */
  #declaredAt(operand: ts.Expression): readonly ts.Type[] {
    const known = this.#declared.get(operand);
    if (known) {
      return known;
    }
    const origin = this.#origin(operand);
    const declared = origin
      ? this.#paths.project(origin.slot.declared, origin.path, [])
      : [];
    this.#declared.set(operand, declared);
    return declared;
  }

  #origin(operand: ts.Expression): Origin | null {
    const known = this.#origins.get(operand);
    if (known !== undefined) {
      return known;
    }
    const traced = this.#tracer.trace(operand);
    const origin =
      traced && (!this.#options.testFile || LOCAL_EDGES.has(traced.slot.kind))
        ? traced
        : null;
    this.#origins.set(operand, origin);
    return origin;
  }

  findings(): readonly WideningFinding[] {
    const findings: WideningFinding[] = [];
    for (const [slot, candidates] of this.#candidates) {
      const finding = this.#slotFinding(slot, candidates);
      if (finding) {
        findings.push(finding);
      }
    }
    return findings;
  }

  #slotFinding(
    slot: Slot,
    candidates: readonly Candidate[]
  ): WideningFinding | null {
    const owner = this.#message.owner(slot);
    const deferred = this.#deferral(slot, owner);
    if (deferred) {
      this.#observe(slot, null, incomplete(deferred));
      return null;
    }
    for (const candidate of candidates) {
      const decision = this.#decide(slot, candidate);
      if (decision.kind === "report") {
        return {
          anchor:
            owner.kind === "local" ? slot.contract : candidate.recovery.node,
          data: this.#message.data(
            slot,
            candidate.recovery,
            candidate.origin,
            decision.producers,
            owner
          ),
        };
      }
      if (decision.kind === "incomplete") {
        this.#observe(slot, candidate, decision);
      }
    }
    return null;
  }

  #deferral(slot: Slot, owner: Owner): string | null {
    if (typeContainsCompilerError(this.#checker, slot.declared)) {
      return "the contract did not resolve";
    }
    if (predicateParameter(slot)) {
      return "the parameter belongs to a type-predicate implementation";
    }
    if (owner.kind === "third-party") {
      return "the contract is a third-party type";
    }
    return mentionsTypeParameter(
      slot.contract,
      typeParameterNames(slot.declaration)
    )
      ? "the contract is generic"
      : null;
  }

  #genericRecovery(recovery: Recovery): boolean {
    const { node, test } = recovery;
    return (
      ((ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) &&
        mentionsTypeParameter(node.type, typeParameterNames(node))) ||
      Boolean(test.target && mentionsTypeVariable(this.#checker, test.target))
    );
  }

  #decide(slot: Slot, candidate: Candidate): Decision {
    if (this.#genericRecovery(candidate.recovery)) {
      return incomplete("the recovered type is generic");
    }
    const evaluation = new CandidateEvaluation(
      this.#checker,
      this.#paths,
      candidate
    );
    const guards = this.#guards.guardsAt(
      candidate.recovery.node,
      candidate.origin
    );
    const narrows = evaluation.slotNarrowing(guards);
    if (narrows !== "uncovered") {
      return narrows === "covered"
        ? CLEAR
        : incomplete("the slot or the recovered type did not resolve");
    }
    const set = this.#producers.of(slot);
    if (set.kind !== "producers") {
      return set.kind === "unseen"
        ? incomplete(`callers out of view: ${set.cause}`)
        : incomplete(set.cause, set.bound);
    }
    if (this.#escapeMatters(slot, candidate, set.escapes)) {
      return incomplete("the value escapes before the recovery");
    }
    const coverage = evaluation.producersPass(set.producers, guards);
    if (evaluation.capped) {
      return incomplete(
        "the structural comparison hit its pair cap",
        boundaryObservations.bounds.wideningCoverPairs
      );
    }
    if (coverage === "incomplete") {
      return incomplete("a producer type did not resolve");
    }
    return coverage === "covered"
      ? { kind: "report", producers: set.producers }
      : CLEAR;
  }

  #escapeMatters(
    slot: Slot,
    candidate: Candidate,
    escapes: readonly ts.Node[]
  ): boolean {
    const declared = slot.declared.getNonNullableType();
    const container = (declared.isUnion() ? declared.types : [declared]).some(
      (member) =>
        (member.flags & CONTAINER_FLAGS) !== 0 &&
        (this.#checker.isArrayLikeType(member) ||
          this.#checker.getIndexInfosOfType(member).length > 0)
    );
    if (!container && candidate.origin.path.length === 0) {
      return false;
    }
    const node = candidate.recovery.node;
    const scope = ts.isParameter(slot.declaration)
      ? slot.declaration.parent
      : slot.declaration.getSourceFile();
    return escapes.some(
      (escape) =>
        !(escape.pos >= node.pos && escape.end <= node.end) &&
        (escape.end <= node.getStart() || sharesLoop(escape, node, scope))
    );
  }

  #observe(slot: Slot, candidate: Candidate | null, decision: Decision): void {
    const observe = this.#options.observe;
    if (!observe || decision.kind !== "incomplete") {
      return;
    }
    const span = (node: ts.Node) => ({
      file: relative(this.#options.cwd, node.getSourceFile().fileName),
      line: lineOf(node),
    });
    observe({
      kind: boundaryObservations.events.wideningIncomplete.kind,
      edge: slot.kind,
      cause: decision.cause,
      slot: span(slot.declaration),
      recovery: candidate ? span(candidate.recovery.node) : null,
    });
    if (decision.bound) {
      observe({
        kind: boundaryObservations.events.boundFired.kind,
        bound: decision.bound.bound,
        limit: decision.bound.limit,
        declaration: slot.subject,
        declarationSpan: span(slot.declaration),
      });
    }
  }
}
