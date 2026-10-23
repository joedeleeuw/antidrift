import { join } from "node:path";
import ts from "typescript";
import {
  declaredDependencies,
  dependencyManifest,
  dependsBack,
  importedName,
  packageDirectory,
  publicEntries,
  specifierPackage,
} from "../../semantic-adapters/provenance/declared-dependencies.ts";
import {
  shapeComparison,
  unresolvedDescription,
} from "../../semantic-adapters/shape/shape-identity.ts";
import { defineTypeScriptRule } from "../../semantic-adapters/kernel/rule-kernel.ts";

const sourcesByProgram = new WeakMap();
const inventoryByProgram = new WeakMap();
const ownerSymbols = ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias;

// Runtime and peer dependencies are the package's contract, so their exported
// types are inventoried. A development dependency, such as a tool or a test
// library, is inventoried only when the package's own files import it.
function packageEntries(packageRoot, modes, options, importedPackages) {
  const contract = new Set(
    declaredDependencies(packageRoot, ["dependencies", "peerDependencies"])
  );
  const entries = [];
  for (const dependency of declaredDependencies(packageRoot)) {
    if (
      !contract.has(dependency) &&
      !importedPackages.has(importedName(dependency))
    ) {
      continue;
    }
    const manifestPath = dependencyManifest(packageRoot, dependency, options);
    if (!manifestPath) continue;
    const reverses = dependsBack(packageRoot, manifestPath);
    const { specifiers } = publicEntries(dependency, manifestPath);
    for (const mode of modes) {
      for (const specifier of specifiers) {
        const resolved = ts.resolveModuleName(
          specifier,
          join(packageRoot, "package.json"),
          options,
          ts.sys,
          undefined,
          undefined,
          mode
        ).resolvedModule;
        if (resolved) {
          entries.push({
            packageName: dependency,
            specifier,
            mode,
            fileName: resolved.resolvedFileName,
            reverses,
          });
        }
      }
    }
  }
  return entries;
}

// The second program needs the linted package's files, the root declaration
// files that may declare its globals, and the missing entries. Other packages'
// sources in a program that spans a whole workspace would only be resolved again.
function programWithEntries(program, packageFileNames, entryFileNames) {
  const missing = [
    ...new Set(
      entryFileNames.filter((fileName) => !program.getSourceFile(fileName))
    ),
  ];
  if (missing.length === 0) return program;
  const options = program.getCompilerOptions();
  const host = ts.createCompilerHost(options, true);
  const parseSourceFile = host.getSourceFile;
  host.getSourceFile = (fileName, languageVersion, onError, recreate) =>
    program.getSourceFile(fileName) ??
    parseSourceFile(fileName, languageVersion, onError, recreate);
  const declarationRoots = program
    .getRootFileNames()
    .filter((fileName) => program.getSourceFile(fileName)?.isDeclarationFile);
  return ts.createProgram({
    rootNames: [
      ...new Set([...declarationRoots, ...packageFileNames, ...missing]),
    ],
    options,
    host,
    projectReferences: program.getProjectReferences(),
  });
}

function propertyKey(type, checker) {
  return JSON.stringify(
    checker
      .getPropertiesOfType(type)
      .map((property) => property.name)
      .sort()
  );
}

function exportedOwners(checker, sourceFile, entry) {
  const moduleSymbol = sourceFile && checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) return [];
  const owners = [];
  const visited = new Set([moduleSymbol]);
  const containers = [{ container: moduleSymbol, prefix: "" }];
  for (const { container, prefix } of containers) {
    for (const exported of checker.getExportsOfModule(container)) {
      const symbol =
        exported.flags & ts.SymbolFlags.Alias
          ? checker.getAliasedSymbol(exported)
          : exported;
      const name = prefix + exported.name;
      if (
        symbol.flags & ownerSymbols &&
        !(symbol.flags & ts.SymbolFlags.Class)
      ) {
        const type = checker.getDeclaredTypeOfSymbol(symbol);
        if (
          !(type.flags & ts.TypeFlags.Any) &&
          checker.getPropertiesOfType(type).length >= 3
        ) {
          owners.push({
            ...entry,
            name,
            type,
            symbol: checker.getMergedSymbol(symbol),
            key: propertyKey(type, checker),
          });
        }
      }
      if (symbol.flags & ts.SymbolFlags.Namespace && !visited.has(symbol)) {
        visited.add(symbol);
        containers.push({ container: symbol, prefix: `${name}.` });
      }
    }
  }
  return owners;
}

function packageSources(program) {
  const cached = sourcesByProgram.get(program);
  if (cached) return cached;
  const sourcesByPackageRoot = new Map();
  for (const source of program.getSourceFiles()) {
    if (
      program.isSourceFileDefaultLibrary(source) ||
      program.isSourceFileFromExternalLibrary(source)
    ) {
      continue;
    }
    const packageRoot = packageDirectory(source.fileName);
    if (packageRoot === null) continue;
    const sources = sourcesByPackageRoot.get(packageRoot) ?? {
      modes: new Set(),
      fileNames: [],
      importedPackages: new Set(),
    };
    sources.modes.add(source.impliedNodeFormat);
    sources.fileNames.push(source.fileName);
    for (const specifier of source.imports ?? []) {
      const imported = specifierPackage(specifier.text);
      if (imported) sources.importedPackages.add(imported);
    }
    sourcesByPackageRoot.set(packageRoot, sources);
  }
  sourcesByProgram.set(program, sourcesByPackageRoot);
  return sourcesByPackageRoot;
}

// A program spanning several workspace packages loads every package's
// dependencies, but a file is only compared with its own package's. Each
// program keeps the inventory of the package it last linted: files lint in path
// order, so a package's files arrive together, and the second program behind an
// inventory is not held for packages already finished.
function dependencyInventory(program, packageRoot) {
  const cached = inventoryByProgram.get(program);
  if (cached?.packageRoot === packageRoot) return cached.inventory;
  const sources = packageSources(program).get(packageRoot);
  if (!sources) return null;
  const entries = packageEntries(
    packageRoot,
    sources.modes,
    program.getCompilerOptions(),
    sources.importedPackages
  );
  const expanded = programWithEntries(
    program,
    sources.fileNames,
    entries.map((entry) => entry.fileName)
  );
  const checker = expanded.getTypeChecker();
  const ownersByEntry = new Map();
  const scopes = new Map();
  for (const entry of entries) {
    const entryKey = `${entry.packageName}\0${entry.specifier}\0${entry.fileName}`;
    if (!ownersByEntry.has(entryKey)) {
      ownersByEntry.set(
        entryKey,
        exportedOwners(checker, expanded.getSourceFile(entry.fileName), entry)
      );
    }
    const owners = scopes.get(entry.mode) ?? new Map();
    for (const owner of ownersByEntry.get(entryKey)) {
      const bucket = owners.get(owner.key) ?? [];
      bucket.push(owner);
      owners.set(owner.key, bucket);
    }
    scopes.set(entry.mode, owners);
  }
  for (const owners of scopes.values()) {
    for (const bucket of owners.values()) {
      bucket.sort(
        (left, right) =>
          left.name.split(".").length - right.name.split(".").length ||
          left.specifier.length - right.specifier.length
      );
    }
  }
  const inventory = { program: expanded, checker, scopes };
  inventoryByProgram.set(program, { packageRoot, inventory });
  return inventory;
}

export function ruleNoRestatedDependencyType() {
  return defineTypeScriptRule({
    ruleName: "no-restated-dependency-type",
    meta: {
      type: "problem",
      docs: {
        description:
          "Require importing an object type that a declared dependency already exports instead of restating it.",
      },
      schema: [],
      messages: {
        restated:
          "This type restates {{name}} exported by the dependency {{packageName}}. Import it from '{{specifier}}' instead of redeclaring it.",
        restatedAmong:
          "This type restates {{owners}}, exported by declared dependencies. Import the one that owns this concept instead of redeclaring it.",
        reversed:
          "This type restates {{owners}}, but {{packageName}} depends on this package. Give the shape one owner that both packages can import.",
        undecided:
          "Whether this type restates {{name}} exported by the dependency {{packageName}} is undecided because {{unresolved}} does not resolve.",
      },
    },
    run({ sourceFile, program, cwd, reportNode }) {
      const packageRoot = packageDirectory(sourceFile.fileName);
      if (!packageRoot) return;
      const inventory = dependencyInventory(program, packageRoot);
      if (!inventory) return;
      const { checker, scopes } = inventory;
      const sameShape = shapeComparison(inventory.program);
      function check(declaration) {
        if (declaration.members.length < 3) return;
        const declared =
          ts.isInterfaceDeclaration(declaration) &&
          checker.getSymbolAtLocation(declaration.name);
        if (
          declared &&
          checker
            .getMergedSymbol(declared)
            .declarations?.some(
              (merged) =>
                packageDirectory(merged.getSourceFile().fileName) !==
                packageRoot
            )
        ) {
          return;
        }
        const type = checker.getTypeAtLocation(declaration);
        const verdicts = (
          scopes
            .get(sourceFile.impliedNodeFormat)
            ?.get(propertyKey(type, checker)) ?? []
        )
          .filter((candidate) =>
            candidate.symbol.declarations?.some(
              (ownerDeclaration) =>
                packageDirectory(ownerDeclaration.getSourceFile().fileName) !==
                packageRoot
            )
          )
          .map((candidate) => ({
            owner: candidate,
            verdict: sameShape(type, candidate.type),
          }));
        const restating = verdicts
          .filter(({ verdict }) => verdict === true)
          .map(({ owner }) => owner);
        const owners = restating.filter(
          (owner, index) =>
            restating.findIndex(({ symbol }) => symbol === owner.symbol) ===
            index
        );
        const listed = owners
          .map(
            (owner) => `${owner.name} from '${importedName(owner.specifier)}'`
          )
          .join(", ");
        const reversed = owners.find((owner) => owner.reverses);
        if (reversed) {
          reportNode(declaration, {
            messageId: "reversed",
            data: { owners: listed, packageName: reversed.packageName },
          });
          return;
        }
        if (owners.length > 1) {
          reportNode(declaration, {
            messageId: "restatedAmong",
            data: { owners: listed },
          });
          return;
        }
        if (owners.length === 1) {
          reportNode(declaration, {
            messageId: "restated",
            data: {
              name: owners[0].name,
              packageName: owners[0].packageName,
              specifier: importedName(owners[0].specifier),
            },
          });
          return;
        }
        const undecided = verdicts.find(
          ({ verdict }) => typeof verdict === "object"
        );
        if (undecided) {
          reportNode(declaration, {
            messageId: "undecided",
            data: {
              name: undecided.owner.name,
              packageName: undecided.owner.packageName,
              unresolved: unresolvedDescription(
                undecided.verdict,
                checker,
                cwd
              ),
            },
          });
        }
      }
      return {
        [ts.SyntaxKind.InterfaceDeclaration]: check,
        [ts.SyntaxKind.TypeLiteral]: check,
      };
    },
  });
}
