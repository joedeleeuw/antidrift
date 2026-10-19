import { dirname, relative } from "node:path";
import ts from "typescript";

export const boundaryObservations = {
  envVar: "ANTIDRIFT_BOUNDARY_OBSERVATIONS",
  events: {
    sinkDecision: {
      kind: "sink-decision",
      reason:
        "Per-sink evaluation wall time, TypeScript checker time, model walk time, trace call count, and memo hit/miss counts.",
    },
    boundFired: {
      kind: "bound-fired",
      reason:
        "A termination or complexity bound truncated or altered analysis for a call, declaration, or narrowing proof.",
    },
    incompleteRoot: {
      kind: "incomplete-root",
      reason:
        "An unresolved provenance root reached a typed sink with an explicit incompleteness cause.",
    },
    decoderProof: {
      kind: "decoder-proof",
      reason:
        "First-party decoder signature proof judgment and the structural branch that decided it.",
    },
    claimCovered: {
      kind: "claim-covered",
      reason:
        "An earlier first-party contract claim covered a downstream typed use on the same path.",
    },
    summaryFixpoint: {
      kind: "summary-fixpoint",
      reason:
        "A recursive first-party declaration needed more than one iteration before its summary stabilised.",
    },
  },
  sinks: {
    assertion: "assertion",
    declaration: "declaration",
    assignment: "assignment",
    return: "return",
    typeArgument: "type-argument",
    argument: "argument",
  },
  bounds: {
    fieldDepth: {
      bound: "field-depth",
      limit: 2,
      reason:
        "A root's containment path or a parameter placeholder's access path exceeded the field depth of the finite root domain; the remainder is the whole value (over-approximation).",
    },
    returnedFunctionDepth: {
      bound: "returned-function-depth",
      limit: 16,
      reason:
        "Returned call-signature type parameter collection exceeded the returned-function depth limit.",
    },
    narrowingProofPairCap: {
      bound: "narrowing-proof-pair-cap",
      limit: 2048,
      reason:
        "Structural type-pair comparison in cast-narrowing-proof exceeded the seen type-pair cap.",
    },
    traceDepth: {
      bound: "trace-depth",
      limit: 256,
      reason:
        "The expression trace nested deeper than the trace depth; the expression becomes an incomplete root instead of growing the native stack.",
    },
    summaryIterations: {
      bound: "summary-iterations",
      limit: 64,
      reason:
        "A recursive declaration summary reached the fixpoint iteration cap; its summary gains an incomplete root.",
    },
  },
  decoderBranches: {
    assertionBody: "assertion-body",
    predicateReturn: "predicate-return",
    validatedReturn: "validated-return",
    failureLiteral: "failure-literal",
    unprovedNarrowing: "unproved-narrowing",
    derivationRefused: "derivation-refused",
  },
} as const;

export type ObservationSink = (observation: object) => void;

export type ObservedRoot = {
  readonly kind?: string | undefined;
  readonly root?: ts.Node | undefined;
  readonly incomplete?: string | undefined;
};

type BoundSpec =
  (typeof boundaryObservations.bounds)[keyof typeof boundaryObservations.bounds];

type BoundDetails = {
  readonly depth?: number;
  readonly unsettledParameters?: number;
  readonly widened?: number;
  readonly call?: ts.Node | null | undefined;
  readonly declaration?: ts.Node | undefined;
};

type DecoderProof = {
  readonly declaration: ts.Node;
  readonly evidence: {
    readonly kind: string;
    readonly form?: string | undefined;
    readonly parameter: number | undefined;
  };
  readonly proved: boolean;
  readonly branch: string;
};

type ClaimCoverage = {
  readonly claimNode: ts.Node;
  readonly claimContract: ts.Type | null | undefined;
  readonly demandedContract: ts.Type | null | undefined;
  readonly path: readonly string[] | undefined;
  readonly useExpression: ts.Node;
};

export type SinkDecision = {
  readonly sinkKind: string;
  readonly sinkNode: ts.Node;
  readonly expression: ts.Node;
  readonly started: number;
  checkerMs: number;
  checkerCalls: number;
  traceCalls: number;
  memoHits: number;
  memoMisses: number;
};

function roundMs(durationMs: number): number {
  return Math.round(durationMs * 1000) / 1000;
}

function sinkOutcome(roots: readonly ObservedRoot[]): string {
  if (!roots.length) {
    return "safe";
  }
  return roots.some((root) => !root.incomplete)
    ? "decodeUnknown"
    : "incompleteAnalysis";
}

function expressionPreview(node: ts.Node | null | undefined): string | null {
  if (!node) {
    return null;
  }
  const sourceFile = node.getSourceFile();
  return node.getText(sourceFile).replaceAll(/\s+/gu, " ").trim().slice(0, 120);
}

function declarationLabel(declaration: ts.Node | undefined): string | null {
  if (!declaration) {
    return null;
  }
  const sourceFile = declaration.getSourceFile();
  if (ts.isNamedDeclaration(declaration)) {
    return declaration.name.getText(sourceFile);
  }
  const parent = ts.isSourceFile(declaration) ? undefined : declaration.parent;
  if (parent && ts.isVariableDeclaration(parent)) {
    return parent.name.getText(sourceFile);
  }
  return ts.SyntaxKind[declaration.kind];
}

function defaultRootDirectory(program: ts.Program): string {
  const configPath = program.getCompilerOptions().configFilePath;
  return typeof configPath === "string"
    ? dirname(configPath)
    : program.getCommonSourceDirectory() || program.getCurrentDirectory();
}

export class BoundaryObserver {
  enabled: boolean;
  readonly checker: ts.TypeChecker;
  readonly #rawChecker: ts.TypeChecker;
  #sink: ObservationSink | undefined;
  #rootDirectory: string;
  readonly #decisions: SinkDecision[] = [];
  #checkerDepth = 0;

  constructor(
    program: ts.Program,
    observe: ObservationSink | undefined,
    explicitRootDirectory?: string
  ) {
    const rawChecker = program.getTypeChecker();
    this.#rawChecker = rawChecker;
    this.enabled = Boolean(observe);
    this.#sink = observe;
    this.#rootDirectory = observe
      ? (explicitRootDirectory ?? defaultRootDirectory(program))
      : "";
    this.checker = observe ? this.#timedChecker(rawChecker) : rawChecker;
  }

  setSink(
    nextObserve: ObservationSink | undefined,
    nextRootDirectory?: string
  ): void {
    this.#sink = nextObserve;
    if (nextRootDirectory) {
      this.#rootDirectory = nextRootDirectory;
    }
    this.enabled = Boolean(nextObserve);
  }

  beginSink(
    sinkKind: string,
    sinkNode: ts.Node,
    expression: ts.Node
  ): SinkDecision {
    const decision = {
      sinkKind,
      sinkNode,
      expression,
      started: performance.now(),
      checkerMs: 0,
      checkerCalls: 0,
      traceCalls: 0,
      memoHits: 0,
      memoMisses: 0,
    };
    this.#decisions.push(decision);
    return decision;
  }

  finishSink<Root extends ObservedRoot>(
    decision: SinkDecision,
    roots: Root[]
  ): Root[] {
    const wallMs = performance.now() - decision.started;
    this.#decisions.pop();
    this.#reportIncompleteRoots(decision, roots);
    const cappedCheckerMs = Math.min(wallMs, decision.checkerMs);
    this.#sink?.({
      kind: boundaryObservations.events.sinkDecision.kind,
      sinkKind: decision.sinkKind,
      expression: expressionPreview(decision.expression),
      expressionKind: ts.SyntaxKind[decision.expression.kind],
      span: this.#nodeSpan(decision.expression),
      sinkSpan: this.#nodeSpan(decision.sinkNode),
      wallMs: roundMs(wallMs),
      checkerMs: roundMs(cappedCheckerMs),
      modelMs: roundMs(Math.max(0, wallMs - cappedCheckerMs)),
      checkerCalls: decision.checkerCalls,
      traceCalls: decision.traceCalls,
      memoHits: decision.memoHits,
      memoMisses: decision.memoMisses,
      uncheckedRoots: roots.length,
      outcome: sinkOutcome(roots),
    });
    return roots;
  }

  recordTraceCall(): void {
    const currentDecision = this.#decisions.at(-1);
    if (currentDecision) {
      currentDecision.traceCalls += 1;
    }
  }

  recordMemoHit(): void {
    const currentDecision = this.#decisions.at(-1);
    if (currentDecision) {
      currentDecision.memoHits += 1;
    }
  }

  recordMemoMiss(): void {
    const currentDecision = this.#decisions.at(-1);
    if (currentDecision) {
      currentDecision.memoMisses += 1;
    }
  }

  boundFired(boundSpec: BoundSpec, details: BoundDetails): void {
    const currentDecision = this.#decisions.at(-1);
    this.#sink?.({
      kind: boundaryObservations.events.boundFired.kind,
      bound: boundSpec.bound,
      limit: boundSpec.limit,
      ...(details.depth === undefined ? {} : { depth: details.depth }),
      ...(details.unsettledParameters === undefined
        ? {}
        : { unsettledParameters: details.unsettledParameters }),
      ...(details.widened === undefined ? {} : { widened: details.widened }),
      call: details.call ? expressionPreview(details.call) : null,
      callSpan: this.#nodeSpan(details.call),
      declaration: declarationLabel(details.declaration),
      declarationSpan: this.#nodeSpan(details.declaration),
      sinkSpan: currentDecision
        ? this.#nodeSpan(currentDecision.sinkNode)
        : null,
    });
  }

  summaryFixpoint(fixpoint: {
    readonly declaration: ts.Node;
    readonly iterations: number;
  }): void {
    this.#sink?.({
      kind: boundaryObservations.events.summaryFixpoint.kind,
      declaration: declarationLabel(fixpoint.declaration),
      declarationSpan: this.#nodeSpan(fixpoint.declaration),
      iterations: fixpoint.iterations,
    });
  }

  decoderProof(proof: DecoderProof): void {
    const { declaration, evidence } = proof;
    this.#sink?.({
      kind: boundaryObservations.events.decoderProof.kind,
      declaration: declarationLabel(declaration),
      declarationKind: ts.SyntaxKind[declaration.kind],
      span: this.#nodeSpan(declaration),
      signatureKind: evidence.form ?? evidence.kind,
      parameterIndex: evidence.parameter,
      proved: proof.proved,
      branch: proof.branch,
    });
  }

  claimCovered(coverage: ClaimCoverage): void {
    const currentDecision = this.#decisions.at(-1);
    const { claimNode, useExpression } = coverage;
    this.#sink?.({
      kind: boundaryObservations.events.claimCovered.kind,
      claimNode: expressionPreview(claimNode),
      claimKind: ts.SyntaxKind[claimNode.kind],
      claimSpan: this.#nodeSpan(claimNode),
      contract: this.#formatContract(coverage.claimContract),
      demandedContract: this.#formatContract(coverage.demandedContract),
      path: coverage.path ?? [],
      sinkKind: currentDecision ? currentDecision.sinkKind : null,
      useExpression: expressionPreview(useExpression),
      useSpan: this.#nodeSpan(
        currentDecision ? currentDecision.sinkNode : useExpression
      ),
    });
  }

  #reportIncompleteRoots(
    decision: SinkDecision,
    roots: readonly ObservedRoot[]
  ): void {
    const seenIncomplete = new Set<string>();
    for (const root of roots) {
      if (!root.incomplete) {
        continue;
      }
      const rootNode = root.root ?? decision.expression;
      const dedupeKey = `${root.incomplete}:${rootNode.pos}-${rootNode.end}`;
      if (seenIncomplete.has(dedupeKey)) {
        continue;
      }
      seenIncomplete.add(dedupeKey);
      this.#sink?.({
        kind: boundaryObservations.events.incompleteRoot.kind,
        cause: root.incomplete,
        rootKind: root.kind,
        rootExpression: expressionPreview(rootNode),
        rootSpan: this.#nodeSpan(rootNode),
        sinkKind: decision.sinkKind,
        sinkExpression: expressionPreview(decision.expression),
        sinkSpan: this.#nodeSpan(decision.sinkNode),
      });
    }
  }

  #relativeFile(sourceFile: ts.SourceFile): string {
    const relativePath = relative(
      this.#rootDirectory,
      sourceFile.fileName
    ).replaceAll("\\", "/");
    return relativePath || sourceFile.fileName;
  }

  #nodeSpan(node: ts.Node | null | undefined) {
    if (!node) {
      return null;
    }
    const sourceFile = node.getSourceFile();
    const start = sourceFile.getLineAndCharacterOfPosition(
      node.getStart(sourceFile)
    );
    const end = sourceFile.getLineAndCharacterOfPosition(node.end);
    return {
      file: this.#relativeFile(sourceFile),
      line: start.line + 1,
      column: start.character + 1,
      endLine: end.line + 1,
      endColumn: end.character + 1,
    };
  }

  #formatContract(contract: ts.Type | null | undefined): string | null {
    if (!contract) {
      return null;
    }
    if (contract.intrinsicName === "error") {
      return "error";
    }
    return this.#rawChecker.typeToString(contract);
  }

  #timedChecker(rawChecker: ts.TypeChecker): ts.TypeChecker {
    const wrappedMethods = new Map<string | symbol, unknown>();
    return new Proxy(rawChecker, {
      get: (target, property) => {
        const member: unknown = Reflect.get(target, property);
        if (typeof member !== "function") {
          return member;
        }
        if (!wrappedMethods.has(property)) {
          wrappedMethods.set(property, (...callArguments: unknown[]) =>
            this.#timedCall(() => Reflect.apply(member, target, callArguments))
          );
        }
        return wrappedMethods.get(property);
      },
    });
  }

  #timedCall(invoke: () => unknown): unknown {
    const currentDecision = this.#decisions.at(-1);
    if (!currentDecision || this.#checkerDepth > 0) {
      return invoke();
    }
    this.#checkerDepth += 1;
    const started = performance.now();
    try {
      return invoke();
    } finally {
      this.#checkerDepth -= 1;
      currentDecision.checkerMs += performance.now() - started;
      currentDecision.checkerCalls += 1;
    }
  }
}
