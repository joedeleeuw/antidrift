import { join } from "node:path";
import ts from "typescript";

import {
  declaredDependencies,
  dependencyManifest,
  dependsBack,
  isInstalledPackageManifest,
  importedName,
  publicEntries,
  specifierPackage,
} from "../provenance/declared-dependencies.ts";
import { completeCoverage, exhaust } from "./discovery-coverage.ts";
import type {
  PackageDiscovery,
  ResolvedPackageEntry,
} from "./package-entry.ts";

const limits = {
  dependencyManifests: 64,
  publicEntries: 256,
} as const;

export type PackageEntriesQuery = {
  readonly program: ts.Program;
  readonly packageRoot: string;
  readonly mode: ts.ResolutionMode | undefined;
  readonly options: ts.CompilerOptions;
  readonly discovery: PackageDiscovery;
  readonly usedSpecifiers: ReadonlySet<string> | undefined;
};

function resolvePublicEntry(
  entry: Omit<ResolvedPackageEntry, "fileName">,
  packageRoot: string,
  options: ts.CompilerOptions,
  discovery: PackageDiscovery
): ResolvedPackageEntry | null {
  const resolved = ts.resolveModuleName(
    entry.specifier,
    join(packageRoot, "package.json"),
    options,
    ts.sys,
    undefined,
    undefined,
    entry.mode
  ).resolvedModule;
  if (!resolved) {
    exhaust(discovery.coverage, {
      budget: "public-entry",
      scope: entry.specifier,
      workspace: entry.workspace,
    });
    return null;
  }
  return { ...entry, fileName: resolved.resolvedFileName };
}

type DependencyFacts = {
  readonly discoveries: Map<string, ReturnType<typeof discoverDependency>>;
  manifestPath?: string | null;
  workspace?: boolean;
};

const dependencyListCaches = new WeakMap<
  ts.Program,
  Map<string, readonly string[]>
>();
const dependencyFactCaches = new WeakMap<
  ts.Program,
  Map<string, DependencyFacts>
>();

function discoverDependency(
  packageRoot: string,
  dependency: string,
  manifestPath: string,
  workspace: boolean,
  mode: ts.ResolutionMode | undefined,
  options: ts.CompilerOptions
) {
  const discovery = { coverage: completeCoverage() };
  const reverses = dependsBack(packageRoot, manifestPath);
  const publicEntry = publicEntries(dependency, manifestPath);
  for (const unresolved of publicEntry.undecided) {
    exhaust(discovery.coverage, {
      budget: "public-entry",
      scope: unresolved,
      workspace,
    });
  }
  const entries: ResolvedPackageEntry[] = [];
  for (const specifier of publicEntry.specifiers.slice(
    0,
    limits.publicEntries
  )) {
    const entry = resolvePublicEntry(
      { packageName: dependency, specifier, mode, reverses, workspace },
      packageRoot,
      options,
      discovery
    );
    if (entry) {
      entries.push(entry);
    }
  }
  if (publicEntry.specifiers.length > limits.publicEntries) {
    exhaust(discovery.coverage, {
      budget: "public-entry",
      scope: `${dependency} public entries`,
      workspace,
    });
  }
  return { entries, exhausted: discovery.coverage.exhausted };
}

function dependencyFactsFor(
  program: ts.Program,
  packageRoot: string,
  dependency: string,
  options: ts.CompilerOptions
) {
  const cache =
    dependencyFactCaches.get(program) ?? new Map<string, DependencyFacts>();
  dependencyFactCaches.set(program, cache);
  const key = `${packageRoot}\0${dependency}`;
  const cached = cache.get(key);
  if (cached) {
    return cached;
  }
  const facts: DependencyFacts = { discoveries: new Map() };
  facts.manifestPath = dependencyManifest(packageRoot, dependency, options);
  if (facts.manifestPath) {
    facts.workspace = !isInstalledPackageManifest(facts.manifestPath);
  }
  cache.set(key, facts);
  return facts;
}

function dependencyEntriesForScope(
  dependency: string,
  scope: PackageEntriesQuery
) {
  const { program, packageRoot, mode, options, discovery, usedSpecifiers } =
    scope;
  const requiredByScope =
    usedSpecifiers === undefined ||
    [...usedSpecifiers].some((specifier) => {
      const packageName = specifierPackage(specifier);
      return (
        packageName === dependency || packageName === importedName(dependency)
      );
    });
  const facts = dependencyFactsFor(program, packageRoot, dependency, options);
  if (!facts.manifestPath) {
    if (requiredByScope) {
      exhaust(discovery.coverage, {
        budget: "package",
        scope: `${dependency} manifest`,
        workspace: true,
      });
    }
    return [];
  }
  if (facts.workspace === undefined) {
    throw new TypeError(`${dependency} has no package-owner classification.`);
  }
  const workspace = facts.workspace;
  if (!workspace && !requiredByScope) {
    return [];
  }
  const modeKey = mode === undefined ? "unknown" : String(mode);
  let discovered = facts.discoveries.get(modeKey);
  if (!discovered) {
    discovered = discoverDependency(
      packageRoot,
      dependency,
      facts.manifestPath,
      workspace,
      mode,
      options
    );
    facts.discoveries.set(modeKey, discovered);
  }
  for (const exhaustion of discovered.exhausted) {
    exhaust(discovery.coverage, exhaustion);
  }
  return discovered.entries.filter(
    (entry) =>
      workspace ||
      usedSpecifiers === undefined ||
      usedSpecifiers.has(entry.specifier) ||
      usedSpecifiers.has(importedName(entry.specifier))
  );
}

export function discoverPackageEntries(query: PackageEntriesQuery) {
  const { program, packageRoot, mode, options, discovery, usedSpecifiers } =
    query;
  const coverage = discovery.coverage;
  if (!ts.sys.fileExists(join(packageRoot, "package.json"))) {
    return [];
  }
  const dependencyListCache =
    dependencyListCaches.get(program) ?? new Map<string, readonly string[]>();
  dependencyListCaches.set(program, dependencyListCache);
  let dependencies = dependencyListCache.get(packageRoot);
  if (!dependencies) {
    dependencies = declaredDependencies(packageRoot);
    dependencyListCache.set(packageRoot, dependencies);
  }
  if (dependencies.length > limits.dependencyManifests) {
    exhaust(coverage, {
      budget: "package",
      scope: `${packageRoot} dependency manifests`,
      workspace: true,
    });
  }
  const scope = {
    program,
    packageRoot,
    mode,
    options,
    discovery,
    usedSpecifiers,
  };
  const entries = dependencies
    .slice(0, limits.dependencyManifests)
    .flatMap((dependency) => dependencyEntriesForScope(dependency, scope));
  const ordered = entries.toSorted(
    (left, right) => Number(right.workspace) - Number(left.workspace)
  );
  if (ordered.length > limits.publicEntries) {
    exhaust(coverage, {
      budget: "public-entry",
      scope: `${packageRoot} resolved public entries`,
      workspace: ordered
        .slice(limits.publicEntries)
        .some((entry) => entry.workspace),
      entries: ordered
        .slice(limits.publicEntries)
        .map(({ fileName, workspace }) => ({ fileName, workspace })),
    });
  }
  return ordered.slice(0, limits.publicEntries);
}
