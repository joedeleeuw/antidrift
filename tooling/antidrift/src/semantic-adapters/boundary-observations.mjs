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
      limit: 3,
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
        "The expression trace nested deeper than the trace depth; the expression is an incomplete root (over-approximation) instead of growing the native stack.",
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
};

function roundMs(durationMs) {
  return Math.round(durationMs * 1000) / 1000;
}

function sinkOutcome(roots) {
  if (!roots.length) {
    return "safe";
  }
  return roots.some((root) => !root.incomplete)
    ? "decodeUnknown"
    : "incompleteAnalysis";
}

function expressionPreview(node) {
  if (!node) {
    return null;
  }
  const sourceFile = node.getSourceFile();
  return node.getText(sourceFile).replaceAll(/\s+/gu, " ").trim().slice(0, 120);
}

function declarationLabel(declaration) {
  if (!declaration) {
    return null;
  }
  const sourceFile = declaration.getSourceFile();
  if (declaration.name) {
    return declaration.name.getText(sourceFile);
  }
  if (
    declaration.parent &&
    ts.isVariableDeclaration(declaration.parent) &&
    declaration.parent.name
  ) {
    return declaration.parent.name.getText(sourceFile);
  }
  return ts.SyntaxKind[declaration.kind];
}

export function boundaryObserver(program, observe, explicitRootDirectory) {
  const rawChecker = program.getTypeChecker();
  if (!observe) {
    return {
      enabled: false,
      checker: rawChecker,
    };
  }
  let sinkCallback = observe;
  const configPath = program.getCompilerOptions().configFilePath;
  let rootDirectory =
    explicitRootDirectory ??
    (typeof configPath === "string"
      ? dirname(configPath)
      : program.getCommonSourceDirectory() || program.getCurrentDirectory());
  const decisions = [];
  let checkerDepth = 0;
  const wrappedMethods = new Map();

  function relativeFile(sourceFile) {
    const relativePath = relative(
      rootDirectory,
      sourceFile.fileName
    ).replaceAll("\\", "/");
    return relativePath || sourceFile.fileName;
  }

  function nodeSpan(node) {
    if (!node) {
      return null;
    }
    const sourceFile = node.getSourceFile();
    const start = sourceFile.getLineAndCharacterOfPosition(
      node.getStart(sourceFile)
    );
    const end = sourceFile.getLineAndCharacterOfPosition(node.end);
    return {
      file: relativeFile(sourceFile),
      line: start.line + 1,
      column: start.character + 1,
      endLine: end.line + 1,
      endColumn: end.character + 1,
    };
  }

  function formatContract(contract) {
    if (!contract) {
      return null;
    }
    if (contract.intrinsicName === "error") {
      return "error";
    }
    return rawChecker.typeToString(contract);
  }

  const checker = new Proxy(rawChecker, {
    get(target, property) {
      const member = target[property];
      if (typeof member !== "function") {
        return member;
      }
      let wrapped = wrappedMethods.get(property);
      if (!wrapped) {
        wrapped = (...callArguments) => {
          const currentDecision = decisions.at(-1);
          if (!currentDecision || checkerDepth > 0) {
            return member.apply(target, callArguments);
          }
          checkerDepth += 1;
          const started = performance.now();
          try {
            return member.apply(target, callArguments);
          } finally {
            checkerDepth -= 1;
            currentDecision.checkerMs += performance.now() - started;
            currentDecision.checkerCalls += 1;
          }
        };
        wrappedMethods.set(property, wrapped);
      }
      return wrapped;
    },
  });

  function beginSink(sinkKind, sinkNode, expression) {
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
    decisions.push(decision);
    return decision;
  }

  function finishSink(decision, roots) {
    const wallMs = performance.now() - decision.started;
    decisions.pop();
    const seenIncomplete = new Set();
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
      sinkCallback({
        kind: boundaryObservations.events.incompleteRoot.kind,
        cause: root.incomplete,
        rootKind: root.kind,
        rootExpression: expressionPreview(rootNode),
        rootSpan: nodeSpan(rootNode),
        sinkKind: decision.sinkKind,
        sinkExpression: expressionPreview(decision.expression),
        sinkSpan: nodeSpan(decision.sinkNode),
      });
    }
    const cappedCheckerMs = Math.min(wallMs, decision.checkerMs);
    sinkCallback({
      kind: boundaryObservations.events.sinkDecision.kind,
      sinkKind: decision.sinkKind,
      expression: expressionPreview(decision.expression),
      expressionKind: ts.SyntaxKind[decision.expression.kind],
      span: nodeSpan(decision.expression),
      sinkSpan: nodeSpan(decision.sinkNode),
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

  function recordTraceCall() {
    const currentDecision = decisions.at(-1);
    if (currentDecision) {
      currentDecision.traceCalls += 1;
    }
  }

  function recordMemoHit() {
    const currentDecision = decisions.at(-1);
    if (currentDecision) {
      currentDecision.memoHits += 1;
    }
  }

  function recordMemoMiss() {
    const currentDecision = decisions.at(-1);
    if (currentDecision) {
      currentDecision.memoMisses += 1;
    }
  }

  function boundFired(boundSpec, details) {
    const currentDecision = decisions.at(-1);
    sinkCallback({
      kind: boundaryObservations.events.boundFired.kind,
      bound: boundSpec.bound,
      limit: boundSpec.limit,
      ...(details.depth === undefined ? {} : { depth: details.depth }),
      ...(details.unsettledParameters === undefined
        ? {}
        : { unsettledParameters: details.unsettledParameters }),
      ...(details.widened === undefined ? {} : { widened: details.widened }),
      call: details.call ? expressionPreview(details.call) : null,
      callSpan: nodeSpan(details.call),
      declaration: declarationLabel(details.declaration),
      declarationSpan: nodeSpan(details.declaration),
      sinkSpan: currentDecision ? nodeSpan(currentDecision.sinkNode) : null,
    });
  }

  function summaryFixpoint({ declaration, iterations }) {
    sinkCallback({
      kind: boundaryObservations.events.summaryFixpoint.kind,
      declaration: declarationLabel(declaration),
      declarationSpan: nodeSpan(declaration),
      iterations,
    });
  }

  function decoderProof({ declaration, evidence, proved, branch }) {
    sinkCallback({
      kind: boundaryObservations.events.decoderProof.kind,
      declaration: declarationLabel(declaration),
      declarationKind: ts.SyntaxKind[declaration.kind],
      span: nodeSpan(declaration),
      signatureKind: evidence.form ?? evidence.kind,
      parameterIndex: evidence.parameter,
      proved,
      branch,
    });
  }

  function claimCovered({
    claimNode,
    claimContract,
    demandedContract,
    path,
    useExpression,
  }) {
    const currentDecision = decisions.at(-1);
    sinkCallback({
      kind: boundaryObservations.events.claimCovered.kind,
      claimNode: expressionPreview(claimNode),
      claimKind: ts.SyntaxKind[claimNode.kind],
      claimSpan: nodeSpan(claimNode),
      contract: formatContract(claimContract),
      demandedContract: formatContract(demandedContract),
      path: path ?? [],
      sinkKind: currentDecision ? currentDecision.sinkKind : null,
      useExpression: expressionPreview(useExpression),
      useSpan: nodeSpan(
        currentDecision ? currentDecision.sinkNode : useExpression
      ),
    });
  }

  const observer = {
    enabled: true,
    checker,
    setSink(nextObserve, nextRootDirectory) {
      sinkCallback = nextObserve;
      if (nextRootDirectory) {
        rootDirectory = nextRootDirectory;
      }
      observer.enabled = Boolean(nextObserve);
    },
    beginSink,
    finishSink,
    recordTraceCall,
    recordMemoHit,
    recordMemoMiss,
    boundFired,
    summaryFixpoint,
    decoderProof,
    claimCovered,
  };
  return observer;
}
