import ts from "typescript";
import { ELEMENT } from "./boundary-contracts.mjs";
import { boundaryObservations } from "./boundary-observations.mjs";

export const FIELD_DEPTH = boundaryObservations.bounds.fieldDepth.limit;

const SUMMARY_ITERATION_INVARIANT = 64;

export function nodeKey(node) {
  if (!node) return "";
  return `${node.getSourceFile().fileName}:${node.pos}:${node.end}`;
}

const objectIds = new WeakMap();
let nextObjectId = 0;

function objectId(object) {
  if (!object) return "";
  let id = objectIds.get(object);
  if (id === undefined) {
    nextObjectId += 1;
    id = nextObjectId;
    objectIds.set(object, id);
  }
  return String(id);
}

function claimKey(claim) {
  if (claim === null) return "cleared";
  if (!claim) return "";
  return `${nodeKey(claim.node)}#${claim.contract ? objectId(claim.contract) : "?"}`;
}

function setKey(keys) {
  return keys ? [...keys].sort().join(",") : "";
}

function stepKey(step) {
  return step.elementKey && !step.keys
    ? ELEMENT
    : `${setKey(step.keys)}@${step.at}`;
}

function flagsKey(flags) {
  return Object.keys(flags)
    .sort()
    .map((name) => {
      const flag = flags[name];
      if (flag === undefined) return `${name}=`;
      if (typeof flag === "object") {
        return `${name}=${flag.call ? nodeKey(flag.call) : nodeKey(flag)}`;
      }
      return `${name}=${String(flag)}`;
    })
    .join(";");
}

function captureKey(capture) {
  return `${capture.kind}@${nodeKey(capture.call)}:${capture.opaque}`;
}

export function rootKey(root) {
  const shared = [
    (root.path ?? []).join("/"),
    root.deep ? "deep" : "",
    setKey(root.overrides),
    claimKey(root.claim),
  ].join("|");
  if (root.parameter) {
    return [
      "placeholder",
      nodeKey(root.parameter),
      root.access.map(stepKey).join(">"),
      root.deepAccess ? "deepAccess" : "",
      root.filter ?? "",
      root.captures.map(captureKey).join(">"),
      flagsKey(root.flags),
      shared,
    ].join("|");
  }
  return [
    root.kind,
    nodeKey(root.root),
    nodeKey(root.declaration),
    root.opaque ? "opaque" : "",
    root.decoded ? "decoded" : "",
    root.pending ? nodeKey(root.pending.call) : "",
    root.activation ?? "",
    root.castChain ? "castChain" : "",
    root.incomplete ?? "",
    shared,
  ].join("|");
}

export function dedupe(roots) {
  const seen = new Set();
  return roots.filter((root) => {
    const key = rootKey(root);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sameRoots(left, right) {
  if (left.length !== right.length) return false;
  const rightKeys = new Set(right.map(rootKey));
  return left.every((root) => rightKeys.has(rootKey(root)));
}

export function placeholder(parameter, claim) {
  return {
    parameter,
    access: [],
    deepAccess: false,
    filter: null,
    captures: [],
    claim: claim ? { ...claim, afterAccess: 0 } : undefined,
    flags: {},
    overrides: undefined,
    path: [],
    deep: false,
  };
}

export function rootAlgebra({ contracts, narrowedToSuccess, observer }) {
  const { memberContract, projectContract } = contracts;

  const truncatedAt = new Set();

  function observeTruncation(at) {
    if (!observer.enabled || truncatedAt.has(at)) return;
    truncatedAt.add(at);
    observer.boundFired(boundaryObservations.bounds.fieldDepth, {
      declaration: at,
    });
  }

  function prefixedPath(path, deep, steps, at) {
    const joined = [...steps, ...path];
    if (joined.length <= FIELD_DEPTH) {
      return { path: joined, deep };
    }
    if (!truncatedAt.has(at)) observeTruncation(at);
    return { path: joined.slice(0, FIELD_DEPTH), deep: true };
  }

  function prefixed(root, step, at) {
    const { path, deep } = prefixedPath(
      root.path ?? [],
      Boolean(root.deep),
      [step],
      at
    );
    return { ...root, path, deep };
  }

  function claimed(root, contract, node) {
    if (root.parameter) {
      if (root.flags.decoded || root.flags.incomplete) return root;
      return {
        ...root,
        claim: {
          contract: projectContract(contract, root.path),
          node,
          afterAccess: root.access.length,
        },
      };
    }
    if (root.decoded || root.incomplete) return root;
    return {
      ...root,
      claim: { contract: projectContract(contract, root.path ?? []), node },
    };
  }

  function flagged(root, flags) {
    if (!root.parameter) {
      const next = { ...root, ...flags };
      if ("path" in flags) next.deep = false;
      return next;
    }
    const next = { ...root, flags: { ...root.flags } };
    for (const [name, flag] of Object.entries(flags)) {
      if (name === "claim") {
        next.claim = flag === undefined ? null : flag;
      } else if (name === "path") {
        next.path = [];
        next.deep = false;
      } else if (name === "overrides") {
        next.overrides = flag;
      } else {
        next.flags[name] = flag;
      }
    }
    return next;
  }

  function overridden(roots, keys) {
    if (!keys.size) return roots;
    return roots.flatMap((root) => {
      if (root.path?.length) {
        return keys.has(root.path[0]) ? [] : [root];
      }
      if (root.deep) return [root];
      return [
        { ...root, overrides: new Set([...(root.overrides ?? []), ...keys]) },
      ];
    });
  }

  function captured(roots, capture) {
    if (!roots.length) return capture.whenEmpty();
    return roots.map((root) => {
      if (root.parameter) {
        return {
          ...root,
          captures: [...root.captures, capture],
          claim: undefined,
          flags: {},
          overrides: undefined,
          path: [],
          deep: false,
        };
      }
      return {
        kind: capture.kind,
        root: capture.call,
        declaration: capture.declaration,
        upstream: root,
        opaque: capture.opaque,
      };
    });
  }

  function filtered(roots, filter) {
    return roots.flatMap((root) => {
      if (root.parameter) {
        return [{ ...root, filter }];
      }
      return root.opaque || root.incomplete ? [root] : [];
    });
  }

  function pathMatches(step, keys, elementKey) {
    if (step === ELEMENT) return elementKey;
    return keys === null || keys.has(step);
  }

  function settleCarrier(root, step) {
    const singleKey = step.keys?.size === 1 ? [...step.keys][0] : null;
    const pending = root.parameter ? root.flags.pending : root.pending;
    if (!pending) return root;
    if (singleKey !== pending.carrier.payload) return null;
    const proved =
      narrowedToSuccess(step.receiverType, pending.carrier) &&
      !step.assertionDerived();
    return flagged(root, {
      pending: undefined,
      decoded: proved,
      opaque: !proved,
    });
  }

  function projectRoot(root, step) {
    const singleKey = step.keys?.size === 1 ? [...step.keys][0] : null;
    if (root.path?.length) {
      const [head, ...rest] = root.path;
      if (!pathMatches(head, step.keys, step.elementKey)) return [];
      if (root.parameter) return [{ ...root, path: rest }];
      return [{ ...root, path: rest.length ? rest : undefined }];
    }
    if (root.deep) {
      return [{ ...root, overrides: undefined }];
    }
    const settled = settleCarrier(root, step);
    if (!settled) return [];
    if (
      step.keys &&
      [...step.keys].every((key) => settled.overrides?.has(key))
    ) {
      return [];
    }
    if (settled.parameter) {
      return [projectPlaceholder(settled, step, singleKey)];
    }
    return [
      {
        ...settled,
        overrides: undefined,
        claim: settled.claim && {
          ...settled.claim,
          contract: memberContract(settled.claim.contract, singleKey),
        },
      },
    ];
  }

  function projectPlaceholder(root, step, singleKey) {
    const claim = root.claim && {
      ...root.claim,
      contract: memberContract(root.claim.contract, singleKey),
    };
    if (root.deepAccess) {
      return { ...root, overrides: undefined, claim };
    }
    if (root.access.length >= FIELD_DEPTH) {
      observeTruncation(root.parameter);
      return { ...root, deepAccess: true, overrides: undefined, claim };
    }
    return {
      ...root,
      access: [...root.access, step],
      overrides: undefined,
      claim,
    };
  }

  function deepened(root) {
    if (root.parameter) {
      if (root.path.length || root.deep) {
        return { ...root, path: [], deep: true };
      }
      return { ...root, deepAccess: true };
    }
    if (root.path?.length || root.deep) {
      return { ...root, path: undefined, deep: true };
    }
    return root;
  }

  function substitute(root, incoming) {
    let current = incoming;
    let sourcedAt = -1;
    for (const [position, step] of root.access.entries()) {
      if (current.length) {
        current = current.flatMap((candidate) => projectRoot(candidate, step));
      } else {
        current = step.sources();
        sourcedAt = position;
      }
    }
    if (root.deepAccess) current = current.map(deepened);
    if (root.filter) current = filtered(current, root.filter);
    for (const capture of root.captures) {
      current = captured(current, capture);
    }
    if (root.claim === null) {
      current = current.map((candidate) =>
        flagged(candidate, { claim: undefined })
      );
    } else if (root.claim && root.claim.afterAccess > sourcedAt) {
      current = current.map((candidate) =>
        claimed(candidate, root.claim.contract, root.claim.node)
      );
    }
    if (Object.keys(root.flags).length) {
      current = current.map((candidate) => flagged(candidate, root.flags));
    }
    if (root.overrides) current = overridden(current, root.overrides);
    if (root.path.length || root.deep) {
      current = current.map((candidate) => {
        const { path, deep } = prefixedPath(
          candidate.path ?? [],
          Boolean(candidate.deep),
          root.path,
          root.parameter
        );
        return { ...candidate, path, deep: deep || root.deep };
      });
    }
    return current;
  }

  function substituteAll(roots, bound) {
    return roots.flatMap((root) => {
      if (!root.parameter) return [root];
      const binding = bound.get(root.parameter);
      return binding ? substitute(root, binding()) : [root];
    });
  }

  return {
    captured,
    claimed,
    filtered,
    flagged,
    overridden,
    prefixed,
    projectRoot,
    substitute,
    substituteAll,
  };
}

function declarationLabel(declaration) {
  const sourceFile = declaration.getSourceFile();
  if (declaration.name) {
    return declaration.name.getText(sourceFile);
  }
  if (
    ts.isVariableDeclaration(declaration.parent) ||
    ts.isPropertyAssignment(declaration.parent)
  ) {
    return declaration.parent.name.getText(sourceFile);
  }
  return ts.SyntaxKind[declaration.kind];
}

export function declarationSummaries({ bodyRoots, observer, isActive }) {
  const entries = new Map();
  const collectors = [];

  function stampOf(dependency) {
    if (dependency.state) {
      return dependency.state === "computing" ? dependency.iteration : null;
    }
    return isActive(dependency) ? 0 : null;
  }

  function recordCut(dependency) {
    collectors.at(-1)?.set(dependency, stampOf(dependency));
  }

  function propagate(cutAt) {
    const parent = collectors.at(-1);
    if (!parent) return;
    for (const [dependency, stamp] of cutAt) {
      parent.set(dependency, stamp);
    }
  }

  function reusable(entry) {
    return (
      Boolean(entry) &&
      [...entry.cutAt].every(
        ([dependency, stamp]) => stampOf(dependency) === stamp
      )
    );
  }

  function collect(compute) {
    const cutAt = new Map();
    collectors.push(cutAt);
    try {
      return { roots: compute(), cutAt };
    } finally {
      collectors.pop();
    }
  }

  function memoize(store, key, compute, observeReuse) {
    const hit = store.get(key);
    if (reusable(hit)) {
      observeReuse?.(true);
      propagate(hit.cutAt);
      return hit.roots;
    }
    observeReuse?.(false);
    const { roots, cutAt } = collect(compute);
    cutAt.delete(key);
    store.set(key, { roots, cutAt });
    propagate(cutAt);
    return roots;
  }

  function summary(declaration) {
    const existing = entries.get(declaration);
    if (existing?.state === "computing") {
      existing.reentered = true;
      recordCut(existing);
      return existing.roots;
    }
    if (reusable(existing)) {
      propagate(existing.cutAt);
      return existing.roots;
    }
    const entry = {
      roots: [],
      cutAt: new Map(),
      state: "computing",
      iteration: 1,
      reentered: false,
    };
    entries.set(declaration, entry);
    for (;;) {
      const { roots, cutAt } = collect(() => dedupe(bodyRoots(declaration)));
      cutAt.delete(entry);
      entry.cutAt = cutAt;
      const stable = !entry.reentered || sameRoots(roots, entry.roots);
      entry.roots = roots;
      if (stable) break;
      entry.iteration += 1;
      if (entry.iteration > SUMMARY_ITERATION_INVARIANT) {
        throw new Error(
          `boundary model: summary of ${declarationLabel(declaration)} did not stabilise within ${SUMMARY_ITERATION_INVARIANT} iterations`
        );
      }
    }
    entry.state = "done";
    propagate(entry.cutAt);
    if (entry.iteration > 1 && observer.enabled) {
      observer.summaryFixpoint({ declaration, iterations: entry.iteration });
    }
    return entry.roots;
  }

  return { summary, recordCut, memoize };
}

export function aliasTarget(checker, symbol) {
  return symbol && symbol.flags & ts.SymbolFlags.Alias
    ? checker.getAliasedSymbol(symbol)
    : symbol;
}

export function unknownProvenance(expression, cause) {
  return [
    {
      kind: "unresolved-provenance",
      root: expression,
      declaration: null,
      opaque: true,
      incomplete: cause,
    },
  ];
}
