import type ts from "typescript";

import type { BoundaryObserver } from "./boundary-observations.ts";
import { boundaryObservations } from "./boundary-observations.ts";
import type { Root } from "./root-domain.ts";
import { dedupe, sameRoots, unknownProvenance } from "./root-domain.ts";

const SUMMARY_ITERATION_INVARIANT =
  boundaryObservations.bounds.summaryIterations.limit;

type Stamp = number | null;

type Dependency = SummaryEntry | ts.Node;

type CutStamps = Map<Dependency, Stamp>;

type MemoEntry = {
  readonly roots: readonly Root[];
  readonly cutAt: CutStamps;
};

type SummaryContext = {
  readonly bodyRoots: (declaration: ts.Node) => readonly Root[];
  readonly observer: BoundaryObserver;
  readonly isActive: (node: ts.Node) => boolean;
};

type Fixpoint = {
  readonly key: ts.Node | string;
  readonly subject: ts.Node;
  readonly compute: () => readonly Root[];
};

class SummaryEntry {
  roots: readonly Root[] = [];
  cutAt: CutStamps = new Map();
  state: "computing" | "done" = "computing";
  iteration = 1;
  reentered = false;
}

class DeclarationSummaries {
  readonly #observer: BoundaryObserver;
  readonly #isActive: SummaryContext["isActive"];
  readonly #entries = new Map<ts.Node | string, SummaryEntry>();
  readonly #collectors: CutStamps[] = [];

  constructor(context: SummaryContext) {
    this.#observer = context.observer;
    this.#isActive = context.isActive;
  }

  recordCut(dependency: Dependency): void {
    this.#collectors.at(-1)?.set(dependency, this.#stampOf(dependency));
  }

  memoize(
    store: Map<ts.Node, MemoEntry>,
    key: ts.Node,
    compute: () => readonly Root[],
    observeReuse?: (reused: boolean) => void
  ): readonly Root[] {
    const hit = store.get(key);
    if (hit && this.#reusable(hit)) {
      observeReuse?.(true);
      this.#propagate(hit.cutAt);
      return hit.roots;
    }
    observeReuse?.(false);
    const { roots, cutAt } = this.#collect(compute);
    cutAt.delete(key);
    store.set(key, { roots, cutAt });
    this.#propagate(cutAt);
    return roots;
  }

  fixpoint(request: Fixpoint): readonly Root[] {
    const { key, subject } = request;
    const existing = this.#entries.get(key);
    if (existing?.state === "computing") {
      existing.reentered = true;
      this.recordCut(existing);
      return existing.roots;
    }
    if (existing && this.#reusable(existing)) {
      this.#propagate(existing.cutAt);
      return existing.roots;
    }
    const entry = new SummaryEntry();
    this.#entries.set(key, entry);
    this.#converge(subject, entry, () => dedupe(request.compute()));
    entry.state = "done";
    this.#propagate(entry.cutAt);
    if (entry.iteration > 1 && this.#observer.enabled) {
      this.#observer.summaryFixpoint({
        declaration: subject,
        iterations: entry.iteration,
      });
    }
    return entry.roots;
  }

  #converge(
    subject: ts.Node,
    entry: SummaryEntry,
    compute: () => readonly Root[]
  ): void {
    for (;;) {
      const { roots, cutAt } = this.#collect(compute);
      cutAt.delete(entry);
      entry.cutAt = cutAt;
      const stable = !entry.reentered || sameRoots(roots, entry.roots);
      entry.roots = roots;
      if (stable) {
        return;
      }
      entry.iteration += 1;
      if (entry.iteration > SUMMARY_ITERATION_INVARIANT) {
        if (this.#observer.enabled) {
          this.#observer.boundFired(
            boundaryObservations.bounds.summaryIterations,
            { declaration: subject }
          );
        }
        entry.roots = [
          ...roots,
          ...unknownProvenance(
            subject,
            `recursive summary did not converge in ${SUMMARY_ITERATION_INVARIANT} iterations`
          ),
        ];
        return;
      }
    }
  }

  #stampOf(dependency: Dependency): Stamp {
    if (dependency instanceof SummaryEntry) {
      return dependency.state === "computing" ? dependency.iteration : null;
    }
    return this.#isActive(dependency) ? 0 : null;
  }

  #propagate(cutAt: CutStamps): void {
    const parent = this.#collectors.at(-1);
    if (!parent) {
      return;
    }
    for (const [dependency, stamp] of cutAt) {
      parent.set(dependency, stamp);
    }
  }

  #reusable(entry: MemoEntry | SummaryEntry): boolean {
    for (const [dependency, stamp] of entry.cutAt) {
      if (this.#stampOf(dependency) !== stamp) {
        return false;
      }
      if (
        dependency instanceof SummaryEntry &&
        dependency.state === "done" &&
        !dependency.cutAt.size
      ) {
        entry.cutAt.delete(dependency);
      }
    }
    return true;
  }

  #collect(compute: () => readonly Root[]) {
    const cutAt: CutStamps = new Map();
    this.#collectors.push(cutAt);
    try {
      return { roots: compute(), cutAt };
    } finally {
      this.#collectors.pop();
    }
  }
}

export function declarationSummaries(context: SummaryContext) {
  const summaries = new DeclarationSummaries(context);
  return {
    summary: (declaration: ts.Node) =>
      summaries.fixpoint({
        key: declaration,
        subject: declaration,
        compute: () => context.bodyRoots(declaration),
      }),
    fixpoint: summaries.fixpoint.bind(summaries),
    recordCut: summaries.recordCut.bind(summaries),
    memoize: summaries.memoize.bind(summaries),
  };
}
