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
import { ownerProjections } from "../projection/owner-projection.ts";
import { sharedOwnerProjections } from "./projection-cache.ts";
import {
  relevantFilePaths,
  scopedSpecifiers,
} from "../provenance/module-imports.ts";
import type {
  DomainCanonicalEntityRegistry,
  GeneratedSourceRegistry,
  PackageTypeOwnerRegistry,
} from "../type-owner.mjs";
import {
  collectAcceptedPackageCanonicalTypes,
  collectCanonicalTypes,
  collectConvexGeneratedCanonicalTypes,
  collectDomainCanonicalTypes,
  collectGeneratedCanonicalTypes,
} from "../type-owner.mjs";
import {
  completeCoverage,
  exhaust,
  mergeCoverage,
} from "./discovery-coverage.ts";
import type { Coverage } from "./discovery-coverage.ts";
import type {
  IndexedCandidate,
  PackageDiscovery,
  ResolvedPackageEntry,
} from "./package-entry.ts";
import { entryExportsName } from "./public-export-owners.ts";
import { sharedExportedOwners } from "./public-export-cache.ts";
import type { CandidatesFor, OwnerScope } from "./owner-scope.ts";
import { exactShapeCandidates } from "./shape-candidates.ts";

const limits = {
  packageScopes: 8,
  dependencyManifests: 64,
  publicEntries: 256,
  files: 256,
  symbolVisits: 4096,
} as const;

type IndexOptions = {
  readonly program: ts.Program;
  readonly generatedSources?: GeneratedSourceRegistry;
  readonly packageTypeOwners?: PackageTypeOwnerRegistry;
  readonly canonicalEntities?: DomainCanonicalEntityRegistry;
  readonly includeInstalledProposals?: boolean;
};

type PackageQuery = {
  readonly packageRoot: string;
  readonly mode?: ts.ResolutionMode;
  readonly sourceFile?: ts.SourceFile;
  readonly expand?: string;
};

const scopeCaches = new WeakMap<ts.Program, Map<string, OwnerScope>>();

function scopeWithCandidates(
  program: ts.Program,
  checker: ts.TypeChecker,
  candidates: readonly IndexedCandidate[],
  coverage: Coverage
): OwnerScope {
  return {
    program,
    checker,
    candidates,
    missingEntries: [],
    coverage: {
      complete: coverage.exhausted.length === 0,
      exhausted: coverage.exhausted,
    },
  };
}

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

function discoverDependencyEntries(
  packageRoot: string,
  dependency: string,
  mode: ts.ResolutionMode | undefined,
  options: ts.CompilerOptions,
  discovery: PackageDiscovery,
  usedSpecifiers?: ReadonlySet<string>
) {
  const requiredByScope =
    usedSpecifiers === undefined ||
    [...usedSpecifiers].some((specifier) => {
      const packageName = specifierPackage(specifier);
      return (
        packageName === dependency || packageName === importedName(dependency)
      );
    });
  const manifestPath = dependencyManifest(packageRoot, dependency, options);
  if (!manifestPath) {
    if (requiredByScope) {
      exhaust(discovery.coverage, {
        budget: "package",
        scope: `${dependency} manifest`,
        workspace: true,
      });
    }
    return [];
  }
  const workspace = !isInstalledPackageManifest(manifestPath);
  if (!workspace && !requiredByScope) {
    return [];
  }
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
  for (const specifier of publicEntry.specifiers.slice(0, 256)) {
    const entry = resolvePublicEntry(
      { packageName: dependency, specifier, mode, reverses, workspace },
      packageRoot,
      options,
      discovery
    );
    if (
      entry &&
      (entry.workspace ||
        usedSpecifiers === undefined ||
        usedSpecifiers.has(specifier) ||
        usedSpecifiers.has(importedName(specifier)))
    ) {
      entries.push(entry);
    }
  }
  if (publicEntry.specifiers.length > 256) {
    exhaust(discovery.coverage, {
      budget: "public-entry",
      scope: `${dependency} public entries`,
      workspace,
    });
  }
  return entries;
}

function packageEntries(
  packageRoot: string,
  mode: ts.ResolutionMode | undefined,
  options: ts.CompilerOptions,
  discovery: PackageDiscovery,
  usedSpecifiers?: ReadonlySet<string>
) {
  const coverage = discovery.coverage;
  if (!ts.sys.fileExists(join(packageRoot, "package.json"))) {
    return [];
  }
  const entries: ResolvedPackageEntry[] = [];
  const dependencies = declaredDependencies(packageRoot);
  if (dependencies.length > 64) {
    exhaust(coverage, {
      budget: "package",
      scope: `${packageRoot} dependency manifests`,
      workspace: true,
    });
  }
  for (const dependency of dependencies.slice(0, 64)) {
    entries.push(
      ...discoverDependencyEntries(
        packageRoot,
        dependency,
        mode,
        options,
        discovery,
        usedSpecifiers
      )
    );
  }
  const ordered = entries.toSorted(
    (left, right) => Number(right.workspace) - Number(left.workspace)
  );
  if (ordered.length > 256) {
    exhaust(coverage, {
      budget: "public-entry",
      scope: `${packageRoot} resolved public entries`,
      workspace: ordered.slice(256).some((entry) => entry.workspace),
      entries: ordered
        .slice(256)
        .map(({ fileName, workspace }) => ({ fileName, workspace })),
    });
  }
  return ordered.slice(0, 256);
}

function programWithEntries(
  program: ts.Program,
  fileNames: readonly string[],
  discovery: PackageDiscovery,
  sourceFile?: ts.SourceFile,
  ownerEntries?: readonly ResolvedPackageEntry[]
) {
  const coverage = discovery.coverage;
  const missing =
    ownerEntries ??
    fileNames.map((fileName) => ({
      fileName,
      workspace: true,
    }));
  const related = fileNames.filter((fileName) =>
    program.getSourceFile(fileName)
  );
  if (missing.length > 256) {
    const omitted = missing.slice(256);
    exhaust(coverage, {
      budget: "file",
      scope: "missing public declaration files",
      workspace: omitted.some((entry) => entry.workspace),
      entries: omitted.map(({ fileName, workspace }) => ({
        fileName,
        workspace,
      })),
    });
  }
  const included = missing.slice(0, 256);
  if (included.length === 0) {
    return program;
  }
  const options = program.getCompilerOptions();
  const host = ts.createCompilerHost(options, true);
  const parseSourceFile = host.getSourceFile;
  host.getSourceFile = (fileName, languageVersion, onError, recreate) =>
    program.getSourceFile(fileName) ??
    parseSourceFile(fileName, languageVersion, onError, recreate);
  return ts.createProgram({
    rootNames: [
      ...new Set([
        ...related,
        ...included.map((entry) => entry.fileName),
        ...(sourceFile ? [sourceFile.fileName] : []),
      ]),
    ],
    options,
    host,
    projectReferences: program.getProjectReferences() ?? [],
    oldProgram: program,
  });
}

function discoverPackageScope(
  program: ts.Program,
  packageRoot: string,
  mode: ts.ResolutionMode | undefined,
  sourceFile?: ts.SourceFile,
  expand?: string
): OwnerScope {
  const coverage = completeCoverage();
  const entries = packageEntries(
    packageRoot,
    mode,
    program.getCompilerOptions(),
    { coverage },
    sourceFile
      ? scopedSpecifiers(program, relevantFilePaths(program, sourceFile))
      : undefined
  );
  const missingEntries = entries.filter(
    (entry) => !program.getSourceFile(entry.fileName)
  );
  const expanded =
    expand === undefined
      ? program
      : programWithEntries(
          program,
          [
            ...(sourceFile ? relevantFilePaths(program, sourceFile) : []),
            ...missingEntries
              .filter((entry) => entryExportsName(entry, expand))
              .map((entry) => entry.fileName),
          ],
          { coverage },
          sourceFile,
          missingEntries.filter((entry) => entryExportsName(entry, expand))
        );
  const checker = expanded.getTypeChecker();
  const candidates = [];
  for (const entry of entries) {
    const sourceFile = expanded.getSourceFile(entry.fileName);
    if (sourceFile) {
      candidates.push(
        ...sharedExportedOwners(checker, sourceFile, entry, packageRoot, {
          coverage,
        })
      );
    }
  }
  if (candidates.length > limits.symbolVisits) {
    candidates.length = limits.symbolVisits;
    exhaust(coverage, {
      budget: "symbol",
      scope: `${packageRoot} owner candidates`,
      workspace: true,
    });
  }
  return {
    ...scopeWithCandidates(expanded, checker, candidates, coverage),
    missingEntries,
  };
}

function discoverBaseScope(program: ts.Program, options: IndexOptions) {
  const coverage = completeCoverage();
  const candidates = [
    ...collectGeneratedCanonicalTypes(
      program,
      program.getTypeChecker(),
      options.generatedSources ?? {}
    ),
    ...collectAcceptedPackageCanonicalTypes(
      program,
      program.getTypeChecker(),
      options.packageTypeOwners ?? {}
    ),
    ...collectDomainCanonicalTypes(
      program,
      program.getTypeChecker(),
      options.canonicalEntities ?? {}
    ),
    ...collectConvexGeneratedCanonicalTypes(program, program.getTypeChecker()),
  ];
  if (options.includeInstalledProposals) {
    candidates.push(
      ...collectCanonicalTypes(program, program.getTypeChecker())
    );
  }
  if (candidates.length > limits.symbolVisits) {
    candidates.length = limits.symbolVisits;
    exhaust(coverage, {
      budget: "symbol",
      scope: "configured and conventional owner candidates",
    });
  }
  return scopeWithCandidates(
    program,
    program.getTypeChecker(),
    candidates,
    coverage
  );
}

function optionKey(options: IndexOptions) {
  return JSON.stringify({
    generatedSources: options.generatedSources ?? {},
    packageTypeOwners: options.packageTypeOwners ?? {},
    canonicalEntities: options.canonicalEntities ?? {},
    includeInstalledProposals: options.includeInstalledProposals === true,
  });
}

function ownerProjectionsForUse(
  candidatesFor: CandidatesFor,
  {
    packageRoot,
    mode,
    sourceFile,
    candidates,
  }: PackageQuery & {
    candidates?: readonly IndexedCandidate[];
  }
) {
  const scope = sourceFile
    ? candidatesFor({ packageRoot, mode, sourceFile })
    : candidatesFor({ packageRoot, mode });
  if (candidates) {
    return sharedOwnerProjections(scope, candidates, packageRoot);
  }
  scope.projections ??= ownerProjections(
    scope.checker,
    scope.candidates.map((candidate) =>
      candidate.authorityState === "accepted"
        ? candidate
        : {
            ...candidate,
            authorityState: "accepted" as const,
            requiresProvenance: true,
          }
    ),
    packageRoot
  );
  return scope.projections;
}

export function createPackageOwnerIndex(options: IndexOptions) {
  const program = options.program;
  const cacheKey = optionKey(options);
  const scopes = scopeCaches.get(program) ?? new Map<string, OwnerScope>();
  scopeCaches.set(program, scopes);
  const baseKey = `base\0${cacheKey}`;
  function baseScope() {
    const cached = scopes.get(baseKey);
    if (cached) {
      return cached;
    }
    const discovered = discoverBaseScope(program, options);
    scopes.set(baseKey, discovered);
    return discovered;
  }
  function candidatesFor({
    packageRoot,
    mode,
    sourceFile,
    expand,
  }: PackageQuery): OwnerScope {
    const sourceKey = sourceFile?.fileName ?? "";
    const key = `${packageRoot}\0${mode ?? "unknown"}\0${sourceKey}\0${expand ?? ""}\0${cacheKey}`;
    const cached = scopes.get(key);
    if (cached) {
      return cached;
    }
    const currentScopes = [...scopes.keys()].filter(
      (scopeKey) =>
        !scopeKey.startsWith("base\0") && !scopeKey.endsWith("\0overflow")
    );
    if (currentScopes.length >= limits.packageScopes) {
      const [oldest] = currentScopes;
      if (oldest) {
        scopes.delete(oldest);
      }
    }
    const discovered = discoverPackageScope(
      program,
      packageRoot,
      mode,
      sourceFile,
      expand
    );
    const base =
      discovered.program === program
        ? baseScope()
        : discoverBaseScope(discovered.program, options);
    const combined = {
      ...scopeWithCandidates(
        discovered.program,
        discovered.checker,
        [...base.candidates, ...discovered.candidates],
        mergeCoverage(base.coverage, discovered.coverage)
      ),
      missingEntries: discovered.missingEntries,
    };
    scopes.set(key, combined);
    return combined;
  }
  return {
    candidatesFor,
    exactShapeCandidates: exactShapeCandidates.bind(null, candidatesFor),
    ownerProjectionsForUse: ownerProjectionsForUse.bind(null, candidatesFor),
  };
}
