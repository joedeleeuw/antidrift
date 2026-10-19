import ts from "typescript";
import { contractProjection } from "./boundary-contracts.ts";
import { classReceivers } from "./class-receivers.ts";
import {
  boundaryObservations,
  BoundaryObserver,
} from "./boundary-observations.ts";
import type { ObservationSink } from "./boundary-observations.ts";
import { boundaryDeclarations } from "./boundary-declarations.ts";
import { ContextualSources } from "./contextual-sources.ts";
import { SignatureForwarding } from "./signature-forwarding.ts";
import { boundarySinks } from "./boundary-sinks.ts";
import { boundarySources } from "./boundary-sources.ts";
import { declarationSummaries } from "./declaration-summaries.ts";
import { rootAlgebra } from "./root-algebra.ts";
import type { Root, AccessStep } from "./root-domain.ts";
import { dedupe, nodeKey, unknownProvenance } from "./root-domain.ts";
import { enclosingFunction } from "./boundary-syntax.ts";
import { memoizedRoots } from "./trace-context.ts";
import type { TraceContext } from "./trace-context.ts";
import { BindingRoots } from "./binding-roots.ts";
import { CallRoots } from "./call-roots.ts";
import { ExpressionRoots } from "./expression-roots.ts";

const TRACE_DEPTH = boundaryObservations.bounds.traceDepth.limit;
type TraceMemo = Parameters<
  ReturnType<typeof declarationSummaries>["memoize"]
>[0];
class RootTrace implements TraceContext {
  readonly program: TraceContext["program"];
  readonly checker: TraceContext["checker"];
  readonly observer: TraceContext["observer"];
  readonly contracts: TraceContext["contracts"];
  readonly declarations: TraceContext["declarations"];
  readonly sources: TraceContext["sources"];
  readonly algebra: TraceContext["algebra"];
  readonly contextualSources: TraceContext["contextualSources"];
  readonly forwarding: TraceContext["forwarding"];
  readonly receivers: TraceContext["receivers"];
  readonly summary: TraceContext["summary"];
  readonly bindingRoots: TraceContext["bindingRoots"];
  readonly parameterRoots: TraceContext["parameterRoots"];
  readonly incomingRoots: TraceContext["incomingRoots"];
  readonly callArgumentsOf: TraceContext["callArgumentsOf"];
  readonly callRoots: TraceContext["callRoots"];
  readonly constructionRoots: TraceContext["constructionRoots"];
  readonly returnRoots: TraceContext["returnRoots"];
  readonly stringified: TraceContext["stringified"];
  readonly concatenationRoots: TraceContext["concatenationRoots"];
  readonly derivedThroughAssertion: TraceContext["derivedThroughAssertion"];
  readonly visiting = new Set<ts.Node>();
  readonly traced: TraceMemo = new Map();
  readonly resolvedTraces: TraceMemo = new Map();
  readonly summaries: ReturnType<typeof declarationSummaries>;
  readonly traceExpression: ExpressionRoots["traceExpression"];
  constructor(program: ts.Program, observer: BoundaryObserver) {
    this.program = program;
    this.observer = observer;
    this.checker = observer.checker;
    this.contracts = contractProjection(this.checker);
    this.declarations = boundaryDeclarations(program, observer);
    this.algebra = rootAlgebra({
      contracts: this.contracts,
      narrowedToSuccess: this.declarations.narrowedToSuccess,
      observer,
    });
    this.sources = boundarySources({
      checker: this.checker,
      declarations: this.declarations,
      hasRoots: (expression) => this.resolvedTrace(expression).length > 0,
    });
    this.summaries = declarationSummaries({
      bodyRoots: (declaration) => this.declarationRoots(declaration),
      observer,
      isActive: (node) => this.visiting.has(node),
    });
    this.summary = this.summaries.summary;
    const bindings = new BindingRoots(this);
    const calls = new CallRoots(this);
    const expressions = new ExpressionRoots(this);
    this.bindingRoots = bindings.bindingRoots.bind(bindings);
    this.parameterRoots = bindings.parameterRoots.bind(bindings);
    this.incomingRoots = bindings.incomingRoots.bind(bindings);
    this.callArgumentsOf = calls.callArgumentsOf.bind(calls);
    this.callRoots = calls.callRoots.bind(calls);
    this.constructionRoots = calls.constructionRoots.bind(calls);
    this.returnRoots = calls.returnRoots.bind(calls);
    this.stringified = calls.stringified.bind(calls);
    this.concatenationRoots = expressions.concatenationRoots.bind(expressions);
    this.derivedThroughAssertion =
      expressions.derivedThroughAssertion.bind(expressions);
    this.traceExpression = expressions.traceExpression.bind(expressions);
    this.contextualSources = new ContextualSources({
      checker: this.checker,
      declarations: this.declarations,
      trace: this.trace.bind(this),
      summary: this.summary,
      fixpoint: this.summaries.fixpoint,
      substituteAll: this.algebra.substituteAll,
      prefixed: this.algebra.prefixed,
      projected: this.projected.bind(this),
      elementStep: this.elementStep.bind(this),
    });
    this.forwarding = new SignatureForwarding({
      checker: this.checker,
      observer,
      declarations: this.declarations,
      trace: this.trace.bind(this),
      flagged: this.algebra.flagged,
      contextual: this.contextualSources,
    });
    this.receivers = classReceivers({
      checker: this.checker,
      origin: this.declarations.origin,
      propertyKeys: this.contracts.propertyKeys,
      trace: this.trace.bind(this),
      summary: this.summary,
      parameterRoots: this.parameterRoots,
      prefixed: this.algebra.prefixed,
    });
  }
  createModel() {
    const trace = this.resolvedTrace.bind(this);
    const sinks = boundarySinks({
      program: this.program,
      checker: this.checker,
      observer: this.observer,
      trace,
      decode: this.declarations.decode,
      unprovedNarrowing: this.declarations.unprovedNarrowing,
      contracts: this.contracts,
    });
    return { trace, decode: this.declarations.decode, ...sinks };
  }
  withClaim(
    roots: readonly Root[],
    contract: ts.Type | null | undefined,
    node: ts.Node,
    claimOptions?: Parameters<TraceContext["withClaim"]>[3]
  ): readonly Root[] {
    const claimedContract = this.contracts.claimContract(
      contract,
      claimOptions
    );
    if (!claimedContract) {
      return roots;
    }
    return roots.map((root) =>
      this.algebra.claimed(root, claimedContract, node)
    );
  }
  accessStep(
    expression: ts.Expression,
    keys: ReadonlySet<string> | null,
    elementKey: boolean,
    sourcesOf: () => readonly Root[]
  ): AccessStep {
    let derived: boolean | undefined;
    return {
      keys,
      elementKey,
      receiverType: this.checker.getTypeAtLocation(expression),
      assertionDerived: () => {
        derived ??= this.derivedThroughAssertion(expression);
        return derived;
      },
      at: nodeKey(expression),
      sources: memoizedRoots(sourcesOf),
    };
  }
  elementStep(expression: ts.Node): AccessStep {
    return {
      keys: null,
      elementKey: true,
      receiverType: this.checker.getTypeAtLocation(expression),
      assertionDerived: () => false,
      at: nodeKey(expression),
      sources: () => [],
    };
  }
  projected(roots: readonly Root[], step: AccessStep): readonly Root[] {
    if (!roots.length) {
      return step.sources();
    }
    return roots.flatMap((root) => this.algebra.projectRoot(root, step));
  }
  resolveAll(roots: readonly Root[]): readonly Root[] {
    return roots.flatMap((root) =>
      root.parameter
        ? this.algebra.substitute(root, this.summary(root.parameter))
        : [root]
    );
  }
  declarationRoots(declaration: ts.Node): readonly Root[] {
    if (ts.isParameter(declaration)) {
      return this.incomingRoots(declaration);
    }
    if (ts.isClassLike(declaration)) {
      return this.receivers.classFieldRoots(declaration);
    }
    return ts.isFunctionLike(declaration) ? this.returnRoots(declaration) : [];
  }
  observeMemo(reused: boolean) {
    if (!this.observer.enabled) {
      return;
    }
    this.observer.recordTraceCall();
    if (reused) {
      this.observer.recordMemoHit();
    } else {
      this.observer.recordMemoMiss();
    }
  }
  trace(expression: ts.Node | undefined): readonly Root[] {
    if (!expression) {
      return [];
    }
    if (this.visiting.has(expression)) {
      this.summaries.recordCut(expression);
      return [];
    }
    if (this.visiting.size >= TRACE_DEPTH) {
      if (this.observer.enabled) {
        this.observer.boundFired(boundaryObservations.bounds.traceDepth, {
          depth: this.visiting.size,
          declaration: enclosingFunction(expression),
        });
      }
      return unknownProvenance(
        expression,
        `trace deeper than ${TRACE_DEPTH} expressions`
      );
    }
    this.visiting.add(expression);
    try {
      return this.summaries.memoize(
        this.traced,
        expression,
        () => dedupe(this.traceExpression(expression)),
        this.observeMemo.bind(this)
      );
    } finally {
      this.visiting.delete(expression);
    }
  }
  resolvedTrace(expression: ts.Node | undefined): readonly Root[] {
    if (!expression) {
      return [];
    }
    return this.summaries.memoize(this.resolvedTraces, expression, () =>
      dedupe(this.resolveAll(this.trace(expression)))
    );
  }
}
type ModelOptions = {
  readonly observe?: ObservationSink;
  readonly rootDirectory?: string;
};
const models = new WeakMap<
  ts.Program,
  {
    readonly model: ReturnType<RootTrace["createModel"]>;
    readonly observer: BoundaryObserver;
    readonly hasProxy: boolean;
  }
>();
export function boundaryModel(program: ts.Program, options: ModelOptions = {}) {
  const existing = models.get(program);
  if (existing) {
    if (options.observe === undefined) {
      return existing.model;
    }
    if (existing.hasProxy) {
      existing.observer.setSink(options.observe, options.rootDirectory);
      return existing.model;
    }
  }
  const observer = new BoundaryObserver(
    program,
    options.observe,
    options.rootDirectory
  );
  const model = new RootTrace(program, observer).createModel();
  models.set(program, { model, observer, hasProxy: Boolean(options.observe) });
  return model;
}
