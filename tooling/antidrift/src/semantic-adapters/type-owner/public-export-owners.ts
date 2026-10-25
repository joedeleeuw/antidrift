import ts from "typescript";

import { packageDirectory } from "../provenance/declared-dependencies.ts";
import { typeProps, typePropsDetailed } from "../type-owner.mjs";
import { exhaust } from "./discovery-coverage.ts";
import type {
  IndexedCandidate,
  PackageDiscovery,
  PackageEntry,
  ResolvedPackageEntry,
} from "./package-entry.ts";

const ownerSymbols = ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias;

export function entryExportsName(
  entry: Pick<ResolvedPackageEntry, "fileName">,
  exportName: string
) {
  const text = ts.sys.readFile(entry.fileName);
  if (text === undefined) {
    return false;
  }
  const sourceFile = ts.createSourceFile(
    entry.fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  return sourceFile.statements.some((statement) => {
    if (
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement)
    ) {
      return (
        statement.name.text === exportName &&
        (ts.getModifiers(statement) ?? []).some(
          (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
        )
      );
    }
    if (!ts.isExportDeclaration(statement)) {
      return false;
    }
    if (statement.exportClause === undefined) {
      return true;
    }
    return (
      ts.isNamedExports(statement.exportClause) &&
      statement.exportClause.elements.some(
        (element) => element.name.text === exportName
      )
    );
  });
}

function indexedExportOwner(
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
  name: string,
  entry: PackageEntry,
  packageRoot: string
): IndexedCandidate | null {
  const type = checker.getDeclaredTypeOfSymbol(symbol);
  if (
    type.flags & ts.TypeFlags.Any ||
    checker.getPropertiesOfType(type).length < 3
  ) {
    return null;
  }
  const declarations = symbol.declarations ?? [];
  const ownerInLocalPackage = declarations.some(
    (declaration) =>
      packageDirectory(declaration.getSourceFile().fileName) === packageRoot
  );
  if (ownerInLocalPackage) {
    return null;
  }
  const merged = checker.getMergedSymbol(symbol);
  return {
    label: `${entry.specifier}#${name}`,
    type,
    props: typeProps(checker, type),
    detailedProps: typePropsDetailed(checker, type),
    authority: "installed-package",
    authorityState: "proposal",
    requiresProvenance: true,
    ownerKey: `${entry.specifier}#${name}`,
    symbol: merged,
    packageName: entry.packageName,
    exportName: name,
    specifier: entry.specifier,
    reverses: entry.reverses,
    workspace: entry.workspace,
  };
}

type ExportDiscovery = {
  entry: PackageEntry;
  discovery: PackageDiscovery;
};

function typeExportOwner(
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
  name: string,
  packageRoot: string,
  search: ExportDiscovery & { visits: { count: number } }
) {
  const { entry, discovery, visits } = search;
  if (!(symbol.flags & ownerSymbols) || symbol.flags & ts.SymbolFlags.Class) {
    return { owner: null, exhausted: false };
  }
  visits.count += 1;
  if (visits.count > 4096) {
    exhaust(discovery.coverage, {
      budget: "symbol",
      scope: `${entry.packageName} symbol visits`,
      workspace: entry.workspace,
    });
    return { owner: null, exhausted: true };
  }
  return {
    owner: indexedExportOwner(checker, symbol, name, entry, packageRoot),
    exhausted: false,
  };
}

type NamespaceContainer = {
  container: ts.Symbol;
  prefix: string;
  depth: number;
};

function queueNamespace(
  symbol: ts.Symbol,
  name: string,
  depth: number,
  search: ExportDiscovery,
  visited: Set<ts.Symbol>,
  containers: NamespaceContainer[]
) {
  const { entry, discovery } = search;
  if (
    !(symbol.flags & ts.SymbolFlags.Namespace) ||
    visited.has(symbol) ||
    containers.some((candidate) => candidate.container === symbol)
  ) {
    return;
  }
  if (depth >= 8) {
    exhaust(discovery.coverage, {
      budget: "export",
      scope: `${entry.packageName} namespace depth`,
      workspace: entry.workspace,
    });
    return;
  }
  visited.add(symbol);
  containers.push({
    container: symbol,
    prefix: `${name}.`,
    depth: depth + 1,
  });
}

export function exportedOwners(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  entry: PackageEntry,
  packageRoot: string,
  discovery: PackageDiscovery
) {
  const coverage = discovery.coverage;
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) {
    return [];
  }
  const owners: IndexedCandidate[] = [];
  const visited = new Set<ts.Symbol>([moduleSymbol]);
  const containers = [{ container: moduleSymbol, prefix: "", depth: 0 }];
  let exportRows = 0;
  const symbolVisits = { count: 0 };
  for (const { container, prefix, depth } of containers) {
    for (const exported of checker.getExportsOfModule(container)) {
      exportRows += 1;
      if (exportRows > 2048) {
        exhaust(coverage, {
          budget: "export",
          scope: `${entry.packageName} export rows`,
          workspace: entry.workspace,
        });
        return owners;
      }
      const symbol =
        exported.flags & ts.SymbolFlags.Alias
          ? checker.getAliasedSymbol(exported)
          : exported;
      const name = prefix + exported.name;
      const { owner, exhausted } = typeExportOwner(
        checker,
        symbol,
        name,
        packageRoot,
        { entry, discovery, visits: symbolVisits }
      );
      if (exhausted) {
        return owners;
      }
      if (owner) {
        owners.push(owner);
      }
      queueNamespace(
        symbol,
        name,
        depth,
        { entry, discovery },
        visited,
        containers
      );
    }
  }
  return owners;
}
