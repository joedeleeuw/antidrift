import type ts from "typescript";

import type { ContractProjections } from "./boundary-contracts.ts";
import { ELEMENT } from "./boundary-contracts.ts";
import type { BoundaryObserver } from "./boundary-observations.ts";
import { boundaryObservations } from "./boundary-observations.ts";
import type { CarrierPaths } from "./carrier-paths.ts";
import type {
  AccessStep,
  PlaceholderRoot,
  Root,
  RootCapture,
  RootClaim,
  RootFlags,
} from "./root-domain.ts";
import { FIELD_DEPTH, dedupe, nodeKey, stepKey } from "./root-domain.ts";

type AlgebraContext = {
  readonly contracts: Pick<
    ContractProjections,
    "memberContract" | "projectContract"
  >;
  readonly narrowedToSuccess: CarrierPaths["narrowedToSuccess"];
  readonly observer: BoundaryObserver;
};

type ProjectedAccess = {
  readonly current: readonly Root[];
  readonly sourcedAt: number;
};

type ParameterBindings = ReadonlyMap<
  ts.ParameterDeclaration,
  () => readonly Root[]
>;

function singleKey(step: AccessStep): string | null {
  return step.keys?.size === 1 ? ([...step.keys][0] ?? null) : null;
}

function pathMatches(
  step: string,
  keys: ReadonlySet<string> | null,
  elementKey: boolean
): boolean {
  if (step === ELEMENT) {
    return elementKey;
  }
  return keys === null || keys.has(step);
}

function deepened(root: Root): Root {
  if (root.parameter) {
    if (root.path.length || root.deep) {
      return { ...root, overrides: undefined, path: [], deep: true };
    }
    return { ...root, overrides: undefined, deepAccess: true };
  }
  if (root.path?.length || root.deep) {
    return { ...root, overrides: undefined, path: undefined, deep: true };
  }
  return { ...root, overrides: undefined };
}

class RootAlgebra {
  readonly #contracts: AlgebraContext["contracts"];
  readonly #narrowedToSuccess: AlgebraContext["narrowedToSuccess"];
  readonly #observer: BoundaryObserver;
  readonly #truncatedAt = new Set<ts.Node>();

  constructor(context: AlgebraContext) {
    this.#contracts = context.contracts;
    this.#narrowedToSuccess = context.narrowedToSuccess;
    this.#observer = context.observer;
  }

  prefixed(root: Root, step: string, at: ts.Node): Root {
    const { path, deep } = this.#prefixedPath(
      root.path ?? [],
      Boolean(root.deep),
      [step],
      at
    );
    return { ...root, overrides: undefined, path, deep };
  }

  claimed(
    root: Root,
    contract: ts.Type | null | undefined,
    node: ts.Node
  ): Root {
    if (root.parameter) {
      if (root.flags.decoded || root.flags.incomplete) {
        return root;
      }
      const projected = this.#contracts.projectContract(contract, root.path);
      if (!projected) {
        return root;
      }
      const hasSourcedStep = root.access.some(
        (step) => step.sources().length > 0
      );
      return {
        ...root,
        claim: {
          contract: projected,
          node,
          afterAccess: hasSourcedStep ? root.access.length : 0,
        },
      };
    }
    if (root.decoded || root.incomplete) {
      return root;
    }
    const projected = this.#contracts.projectContract(
      contract,
      root.path ?? []
    );
    if (!projected) {
      return root;
    }
    return { ...root, claim: { contract: projected, node } };
  }

  flagged(root: Root, flags: RootFlags): Root {
    if (!root.parameter) {
      return "path" in flags
        ? { ...root, ...flags, deep: false }
        : { ...root, ...flags };
    }
    const marks: { -readonly [Name in keyof RootFlags]: RootFlags[Name] } = {
      ...flags,
    };
    delete marks.claim;
    delete marks.path;
    delete marks.overrides;
    return {
      ...root,
      flags: { ...root.flags, ...marks },
      ...("claim" in flags ? { claim: flags.claim ?? null } : {}),
      ...("path" in flags ? { path: [], deep: false } : {}),
      ...("overrides" in flags ? { overrides: flags.overrides } : {}),
    };
  }

  overridden(roots: readonly Root[], keys: ReadonlySet<string>) {
    if (!keys.size) {
      return roots;
    }
    return roots.flatMap((root): Root[] => {
      const [head] = root.path ?? [];
      if (head !== undefined) {
        return keys.has(head) ? [] : [root];
      }
      if (root.deep) {
        return [root];
      }
      return [
        { ...root, overrides: new Set([...(root.overrides ?? []), ...keys]) },
      ];
    });
  }

  captured(roots: readonly Root[], capture: RootCapture): readonly Root[] {
    if (!roots.length) {
      return capture.whenEmpty();
    }
    return roots.map((root): Root => {
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

  filtered(roots: readonly Root[], filter: string): Root[] {
    return roots.flatMap((root): Root[] => {
      if (root.parameter) {
        return [{ ...root, filter }];
      }
      return root.opaque || root.incomplete ? [root] : [];
    });
  }

  projectRoot(root: Root, step: AccessStep): Root[] {
    const key = singleKey(step);
    const [head, ...rest] = root.path ?? [];
    if (head !== undefined) {
      if (!pathMatches(head, step.keys, step.elementKey)) {
        return [];
      }
      if (root.parameter) {
        return [{ ...root, path: rest }];
      }
      return [{ ...root, path: rest.length ? rest : undefined }];
    }
    if (root.deep) {
      return [{ ...root, overrides: undefined }];
    }
    const settled = this.#settleCarrier(root, step);
    if (!settled) {
      return [];
    }
    if (
      step.keys &&
      [...step.keys].every((name) => settled.overrides?.has(name))
    ) {
      return [];
    }
    if (settled.parameter) {
      return [this.#projectPlaceholder(settled, step, key)];
    }
    return [
      {
        ...settled,
        overrides: undefined,
        claim: this.#projectClaim(settled.claim, key),
      },
    ];
  }

  substitute(root: PlaceholderRoot, incoming: readonly Root[]) {
    return this.#applyRootEffects(root, this.#projectAccess(root, incoming));
  }

  substituteAll(roots: readonly Root[], bound: ParameterBindings) {
    const accessCache = new Map<string, ProjectedAccess>();
    return dedupe(
      roots.flatMap((root) => {
        if (!root.parameter) {
          return [root];
        }
        const binding = bound.get(root.parameter);
        if (!binding) {
          return [root];
        }
        const key = `${nodeKey(root.parameter)}|${root.access.map(stepKey).join(">")}|${root.deepAccess ? "1" : ""}`;
        let projectedAccess = accessCache.get(key);
        if (!projectedAccess) {
          projectedAccess = this.#projectAccess(root, binding());
          accessCache.set(key, projectedAccess);
        }
        return this.#applyRootEffects(root, projectedAccess);
      })
    );
  }

  #observeTruncation(at: ts.Node): void {
    if (!this.#observer.enabled || this.#truncatedAt.has(at)) {
      return;
    }
    this.#truncatedAt.add(at);
    this.#observer.boundFired(boundaryObservations.bounds.fieldDepth, {
      declaration: at,
    });
  }

  #prefixedPath(
    path: readonly string[],
    deep: boolean,
    steps: readonly string[],
    at: ts.Node
  ) {
    const joined = [...steps, ...path];
    if (joined.length <= FIELD_DEPTH) {
      return { path: joined, deep };
    }
    if (!this.#truncatedAt.has(at)) {
      this.#observeTruncation(at);
    }
    return { path: joined.slice(0, FIELD_DEPTH), deep: true };
  }

  #settleCarrier(root: Root, step: AccessStep): Root | null {
    const key = singleKey(step);
    const pending = root.parameter ? root.flags.pending : root.pending;
    if (!pending) {
      return root;
    }
    if (key !== pending.carrier.payload) {
      return null;
    }
    const proved =
      this.#narrowedToSuccess(step.receiverType, pending.carrier) &&
      !step.assertionDerived();
    return this.flagged(root, {
      pending: undefined,
      decoded: proved,
      opaque: !proved,
    });
  }

  #projectClaim(claim: RootClaim | null | undefined, key: string | null) {
    if (!claim) {
      return undefined;
    }
    const contract = this.#contracts.memberContract(claim.contract, key);
    return contract ? { ...claim, contract } : undefined;
  }

  #projectPlaceholder(
    root: PlaceholderRoot,
    step: AccessStep,
    key: string | null
  ): PlaceholderRoot {
    const claim = this.#projectClaim(root.claim, key);
    if (root.deepAccess) {
      return { ...root, overrides: undefined, claim };
    }
    if (root.access.length >= FIELD_DEPTH) {
      this.#observeTruncation(root.parameter);
      return { ...root, deepAccess: true, overrides: undefined, claim };
    }
    return {
      ...root,
      access: [...root.access, step],
      overrides: undefined,
      claim,
    };
  }

  #projectAccess(
    root: PlaceholderRoot,
    incoming: readonly Root[]
  ): ProjectedAccess {
    let current = incoming;
    let sourcedAt = -1;
    for (const [position, step] of root.access.entries()) {
      if (current.length) {
        current = current.flatMap((candidate) =>
          this.projectRoot(candidate, step)
        );
      } else {
        current = step.sources();
        sourcedAt = position;
      }
    }
    if (root.deepAccess) {
      current = current.map(deepened);
    }
    return { current: dedupe(current), sourcedAt };
  }

  #applyRootEffects(
    root: PlaceholderRoot,
    projectedAccess: ProjectedAccess
  ): readonly Root[] {
    let { current } = projectedAccess;
    if (!current.length && !root.captures.length) {
      return current;
    }
    if (root.filter) {
      current = this.filtered(current, root.filter);
    }
    for (const capture of root.captures) {
      current = this.captured(current, capture);
    }
    current = this.#claimEffect(root, current, projectedAccess.sourcedAt);
    if (Object.keys(root.flags).length) {
      current = current.map((candidate) => this.flagged(candidate, root.flags));
    }
    if (root.overrides) {
      current = this.overridden(current, root.overrides);
    }
    if (!root.path.length && !root.deep) {
      return current;
    }
    return current.map((candidate) => {
      const { path, deep } = this.#prefixedPath(
        candidate.path ?? [],
        Boolean(candidate.deep),
        root.path,
        root.parameter
      );
      return {
        ...candidate,
        overrides: undefined,
        path,
        deep: deep || root.deep,
      };
    });
  }

  #claimEffect(
    root: PlaceholderRoot,
    current: readonly Root[],
    sourcedAt: number
  ): readonly Root[] {
    const { claim } = root;
    if (claim === null) {
      return current.map((candidate) =>
        this.flagged(candidate, { claim: undefined })
      );
    }
    if (claim?.afterAccess !== undefined && claim.afterAccess > sourcedAt) {
      return current.map((candidate) =>
        this.claimed(candidate, claim.contract, claim.node)
      );
    }
    return current;
  }
}

export function rootAlgebra(context: AlgebraContext) {
  const algebra = new RootAlgebra(context);
  return {
    captured: algebra.captured.bind(algebra),
    claimed: algebra.claimed.bind(algebra),
    filtered: algebra.filtered.bind(algebra),
    flagged: algebra.flagged.bind(algebra),
    overridden: algebra.overridden.bind(algebra),
    prefixed: algebra.prefixed.bind(algebra),
    projectRoot: algebra.projectRoot.bind(algebra),
    substitute: algebra.substitute.bind(algebra),
    substituteAll: algebra.substituteAll.bind(algebra),
  };
}
