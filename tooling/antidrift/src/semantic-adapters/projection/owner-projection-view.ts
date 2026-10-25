import type ts from "typescript";

export type OwnerAuthority = {
  readonly authority: string;
  readonly reverses: boolean;
};

type OwnerSource = OwnerAuthority & {
  readonly label: string;
  readonly root: ts.Type;
};

export type OwnerProjection = OwnerAuthority & {
  readonly type: ts.Type;
  readonly sources: ReadonlyMap<string, OwnerSource>;
  readonly roots: ReadonlySet<ts.Type>;
  readonly label: string;
};

export type ProjectionRecord = {
  readonly type: ts.Type;
  readonly sources: ReadonlyMap<string, OwnerSource>;
};

function sortedJoin(names: Iterable<string>): string {
  return [...new Set(names)].sort().join(" | ");
}

function projectionFor(
  record: ProjectionRecord,
  cache: WeakMap<ReadonlyMap<string, OwnerSource>, OwnerProjection>
): OwnerProjection {
  const cached = cache.get(record.sources);
  if (cached) {
    return cached;
  }
  const sourceList = [...record.sources.values()];
  const projection = {
    type: record.type,
    sources: record.sources,
    roots: new Set(sourceList.map((source) => source.root)),
    authority: sortedJoin(sourceList.map((source) => source.authority)),
    label: sortedJoin(sourceList.map((source) => source.label)),
    reverses: sourceList.some((source) => source.reverses),
  };
  cache.set(record.sources, projection);
  return projection;
}

export function directOwnerReader(
  owners: ReadonlyMap<ts.Type, ProjectionRecord>
) {
  const cache = new WeakMap<
    ReadonlyMap<string, OwnerSource>,
    OwnerProjection
  >();
  return (type: ts.Type) => {
    const record = owners.get(type);
    return record ? projectionFor(record, cache) : undefined;
  };
}
