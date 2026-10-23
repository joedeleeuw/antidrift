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
    wideningIncomplete: {
      kind: "widening-incomplete",
      reason:
        "A round-trip widening candidate went undecided: a producer, contract or recovered type did not resolve, a caller was out of view, or a bound fired.",
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
    wideningCoverPairs: {
      bound: "widening-cover-pairs",
      limit: 2048,
      reason:
        "Structural type-pair comparison in round-trip widening exceeded the seen type-pair cap; the candidate is incomplete.",
    },
    wideningCallSites: {
      bound: "widening-call-sites",
      limit: 150,
      reason:
        "Name occurrences examined while collecting a parameter's callers exceeded the call-site cap; the parameter edge is incomplete.",
    },
    wideningCallerFiles: {
      bound: "widening-caller-files",
      limit: 30,
      reason:
        "Files containing a function's name exceeded the caller-file cap; the parameter edge is incomplete.",
    },
    wideningPackageFiles: {
      bound: "widening-package-files",
      limit: 5000,
      reason:
        "Source files under an exported function's package exceeded the cap while looking for callers outside the program; the parameter edge is incomplete.",
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
