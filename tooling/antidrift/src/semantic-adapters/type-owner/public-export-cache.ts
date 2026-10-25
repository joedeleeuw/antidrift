import type ts from "typescript";

import { completeCoverage, exhaust } from "./discovery-coverage.ts";
import type { Exhaustion } from "./discovery-coverage.ts";
import type { OwnerScope } from "./owner-scope.ts";
import type {
  PackageDiscovery,
  ResolvedPackageEntry,
} from "./package-entry.ts";
import { exportedOwners } from "./public-export-owners.ts";

type CachedExports = {
  readonly candidates: OwnerScope["candidates"];
  readonly exhausted: readonly Exhaustion[];
};

const exportCaches = new WeakMap<ts.TypeChecker, Map<string, CachedExports>>();
const maxCachedPublicEntries = 256;

export function sharedExportedOwners(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  entry: ResolvedPackageEntry,
  packageRoot: string,
  discovery: PackageDiscovery
) {
  const cache = exportCaches.get(checker) ?? new Map<string, CachedExports>();
  exportCaches.set(checker, cache);
  const key = [
    packageRoot,
    sourceFile.fileName,
    entry.packageName,
    entry.specifier,
    entry.mode ?? "",
    entry.reverses,
    entry.workspace,
  ].join("\0");
  const cached = cache.get(key);
  if (cached) {
    for (const exhaustion of cached.exhausted) {
      exhaust(discovery.coverage, exhaustion);
    }
    return cached.candidates;
  }
  const coverage = completeCoverage();
  const candidates = exportedOwners(checker, sourceFile, entry, packageRoot, {
    coverage,
  });
  if (cache.size >= maxCachedPublicEntries) {
    const oldest = cache.keys().next();
    if (!oldest.done) {
      cache.delete(oldest.value);
    }
  }
  cache.set(key, { candidates, exhausted: coverage.exhausted });
  for (const exhaustion of coverage.exhausted) {
    exhaust(discovery.coverage, exhaustion);
  }
  return candidates;
}
