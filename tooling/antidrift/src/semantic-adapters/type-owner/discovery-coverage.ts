export type Exhaustion = {
  readonly budget:
    | "package"
    | "public-entry"
    | "export"
    | "file"
    | "symbol"
    | "provenance";
  readonly scope: string;
  readonly workspace?: boolean;
  readonly entries?: readonly { fileName: string; workspace: boolean }[];
};

export type Coverage = {
  readonly complete: boolean;
  readonly exhausted: readonly Exhaustion[];
};

export function completeCoverage() {
  return { complete: true, exhausted: [] satisfies Exhaustion[] };
}

export function mergeCoverage(...coverages: readonly Coverage[]): Coverage {
  return {
    complete: coverages.every((coverage) => coverage.complete),
    exhausted: coverages.flatMap((coverage) => coverage.exhausted),
  };
}

export function exhaust(
  coverage: { exhausted: Exhaustion[] },
  exhaustion: Exhaustion
) {
  if (
    !coverage.exhausted.some(
      (entry) =>
        entry.budget === exhaustion.budget && entry.scope === exhaustion.scope
    )
  ) {
    coverage.exhausted.push(exhaustion);
  }
}
