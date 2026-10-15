import { join } from "node:path";
import ts from "typescript";
import {
  declaredDependencies,
  dependencyManifest,
  dependsBack,
  importedName,
  publicEntries,
} from "../../semantic-adapters/declared-dependencies.mjs";
import {
  packageDirectory,
  shapeComparison,
  unresolvedDescription,
} from "../../semantic-adapters/shape-identity.mjs";
import { defineTypeScriptRule } from "../../semantic-adapters/ts-rule-kernel.mjs";

const inventoryByProgram = new WeakMap();
const ownerSymbols = ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias;

function packageEntries(packageRoot, modes, options, entriesByManifest) {
  const entries = [];
  for (const dependency of declaredDependencies(packageRoot)) {
    const manifestPath = dependencyManifest(packageRoot, dependency, options);
    if (!manifestPath) continue;
    const reverses = dependsBack(packageRoot, manifestPath);
    if (!entriesByManifest.has(manifestPath)) {
      entriesByManifest.set(
        manifestPath,
        publicEntries(dependency, manifestPath).specifiers
      );
    }
    for (const mode of modes) {
      for (const specifier of entriesByManifest.get(manifestPath)) {
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

function programWithEntries(program, fileNames) {
  const missing = [
    ...new Set(
      fileNames.filter((fileName) => !program.getSourceFile(fileName))
    ),
  ];
  if (missing.length === 0) return program;
  const options = program.getCompilerOptions();
  const host = ts.createCompilerHost(options, true);
  const parseSourceFile = host.getSourceFile;
  host.getSourceFile = (fileName, languageVersion, onError, recreate) =>
    program.getSourceFile(fileName) ??
    parseSourceFile(fileName, languageVersion, onError, recreate);
  return ts.createProgram({
    rootNames: [...program.getRootFileNames(), ...missing],
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

function dependencyInventory(program) {
  const cached = inventoryByProgram.get(program);
  if (cached) return cached;
  const modesByPackageRoot = new Map();
  for (const source of program.getSourceFiles()) {
    if (
      program.isSourceFileDefaultLibrary(source) ||
      program.isSourceFileFromExternalLibrary(source)
    ) {
      continue;
    }
    const packageRoot = packageDirectory(source.fileName);
    if (packageRoot === null) continue;
    const modes = modesByPackageRoot.get(packageRoot) ?? new Set();
    modes.add(source.impliedNodeFormat);
    modesByPackageRoot.set(packageRoot, modes);
  }
  const options = program.getCompilerOptions();
  const entriesByManifest = new Map();
  const packages = new Map(
    [...modesByPackageRoot].map(([packageRoot, modes]) => [
      packageRoot,
      packageEntries(packageRoot, modes, options, entriesByManifest),
    ])
  );
  const expanded = programWithEntries(
    program,
    [...packages.values()].flatMap((entries) =>
      entries.map((entry) => entry.fileName)
    )
  );
  const checker = expanded.getTypeChecker();
  const ownersByEntry = new Map();
  const ownersByScope = new Map();
  for (const [packageRoot, entries] of packages) {
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
    ownersByScope.set(packageRoot, scopes);
  }
  const inventory = { program: expanded, checker, ownersByScope };
  inventoryByProgram.set(program, inventory);
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
      const inventory = dependencyInventory(program);
      const scopes = inventory.ownersByScope.get(packageRoot);
      if (!scopes) return;
      const { checker } = inventory;
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
