import { dirname, join, relative } from "node:path";
import ts from "typescript";
import {
  packageDirectory,
  sameObjectShape,
} from "../../semantic-adapters/shape-identity.mjs";
import {
  missingTypeServicesVisitors,
  requireTypeServices,
} from "./type-services.js";

const inventoryByProgram = new WeakMap();
const manifestDependencyFields = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
];
const ownerSymbols = ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias;

function readManifest(filename) {
  try {
    return JSON.parse(ts.sys.readFile(filename));
  } catch (error) {
    throw new Error(`${filename} is not a readable JSON package manifest`, {
      cause: error,
    });
  }
}

function resolvedManifest(directory, name, options) {
  const resolved = ts.resolveModuleName(
    name,
    join(directory, "package.json"),
    options,
    ts.sys
  ).resolvedModule;
  const resolvedRoot = resolved && packageDirectory(resolved.resolvedFileName);
  if (!resolvedRoot) return null;
  const manifestPath = join(resolvedRoot, "package.json");
  return readManifest(manifestPath).name === name ? manifestPath : null;
}

function dependencyManifest(directory, name) {
  let current = directory;
  while (
    !ts.sys.fileExists(join(current, "node_modules", name, "package.json"))
  ) {
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return join(current, "node_modules", name, "package.json");
}

function exportTargets(entry) {
  if (typeof entry === "string") return [entry];
  if (!entry || typeof entry !== "object") return [];
  return Object.values(entry).flatMap(exportTargets);
}

function publicEntries(name, manifestPath) {
  const manifest = readManifest(manifestPath);
  if (!manifest.exports) return [name];
  const exports =
    typeof manifest.exports === "object" &&
    !Array.isArray(manifest.exports) &&
    Object.keys(manifest.exports).some((key) => key.startsWith("."))
      ? manifest.exports
      : { ".": manifest.exports };
  const entries = new Set();
  const packageRoot = dirname(manifestPath);
  for (const [entry, target] of Object.entries(exports)) {
    if (!target) continue;
    if (!entry.includes("*")) {
      entries.add(entry === "." ? name : name + entry.slice(1));
      continue;
    }
    for (const filename of ts.sys.readDirectory(
      packageRoot,
      [".ts", ".mts", ".cts"],
      ["node_modules"]
    )) {
      for (const pattern of exportTargets(target)) {
        if (!pattern.includes("*")) continue;
        const [prefix, suffix] = join(packageRoot, pattern).split("*");
        if (filename.startsWith(prefix) && filename.endsWith(suffix)) {
          const replacement = filename.slice(
            prefix.length,
            filename.length - suffix.length
          );
          entries.add(name + entry.slice(1).replace("*", () => replacement));
        }
      }
    }
  }
  return [...entries];
}

function packageEntries(packageRoot, modes, options, entriesByManifest) {
  const manifest = readManifest(join(packageRoot, "package.json"));
  const dependencies = [
    ...new Set(
      manifestDependencyFields.flatMap((field) =>
        Object.keys(manifest[field] ?? {})
      )
    ),
  ];
  const uninstalled = [];
  const entries = [];
  for (const dependency of dependencies) {
    const manifestPath =
      dependencyManifest(packageRoot, dependency) ??
      resolvedManifest(packageRoot, dependency, options);
    if (!manifestPath) {
      uninstalled.push(dependency);
      continue;
    }
    if (!entriesByManifest.has(manifestPath)) {
      entriesByManifest.set(
        manifestPath,
        publicEntries(dependency, manifestPath)
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
          });
        }
      }
    }
  }
  return { entries, uninstalled };
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
    [...packages.values()].flatMap(({ entries }) =>
      entries.map((entry) => entry.fileName)
    )
  );
  const checker = expanded.getTypeChecker();
  const ownersByEntry = new Map();
  const ownersByScope = new Map();
  for (const [packageRoot, { entries, uninstalled }] of packages) {
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
            left.name.split(".").length - right.name.split(".").length
        );
      }
    }
    ownersByScope.set(packageRoot, {
      scopes,
      ...coverageGaps(program, packageRoot, uninstalled),
    });
  }
  const inventory = { program: expanded, checker, ownersByScope };
  inventoryByProgram.set(program, inventory);
  return inventory;
}

function importedName(packageName) {
  const typesPackage = /^@types\/(.+)$/u.exec(packageName);
  if (!typesPackage) return packageName;
  const [scope, name] = typesPackage[1].split("__");
  return name ? `@${scope}/${name}` : scope;
}

function specifierPackage(specifier) {
  if (/^(?:\.|\/|[a-z]+:)/u.test(specifier)) return null;
  return specifier
    .split("/")
    .slice(0, specifier.startsWith("@") ? 2 : 1)
    .join("/");
}

function moduleSpecifiers(node, specifiers = []) {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier &&
    ts.isStringLiteral(node.moduleSpecifier)
  ) {
    specifiers.push(node.moduleSpecifier);
  } else if (
    ts.isExternalModuleReference(node) &&
    ts.isStringLiteral(node.expression)
  ) {
    specifiers.push(node.expression);
  } else if (
    ts.isCallExpression(node) &&
    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) &&
        node.expression.text === "require")) &&
    node.arguments[0] &&
    ts.isStringLiteralLike(node.arguments[0])
  ) {
    specifiers.push(node.arguments[0]);
  } else if (
    ts.isImportTypeNode(node) &&
    ts.isLiteralTypeNode(node.argument) &&
    ts.isStringLiteral(node.argument.literal)
  ) {
    specifiers.push(node.argument.literal);
  }
  ts.forEachChild(node, (child) => {
    moduleSpecifiers(child, specifiers);
  });
  return specifiers;
}

function missingDependencyNames(uninstalled) {
  return new Map(
    uninstalled.flatMap((packageName) => [
      [packageName, packageName],
      [importedName(packageName), packageName],
    ])
  );
}

function packageGapFile(packageRoot) {
  return ts.sys
    .readDirectory(
      packageRoot,
      [".ts", ".tsx", ".mts", ".cts"],
      ["**/node_modules"]
    )
    .filter(
      (fileName) =>
        !/\.d\.[cm]?ts$/u.test(fileName) &&
        packageDirectory(fileName) === packageRoot
    )
    .sort()[0];
}

function coverageGaps(program, packageRoot, uninstalled) {
  if (uninstalled.length === 0) {
    return { missingByName: new Map(), unimported: [], gapFile: null };
  }
  const missingByName = missingDependencyNames(uninstalled);
  const imported = new Set();
  for (const source of program.getSourceFiles()) {
    if (
      program.isSourceFileDefaultLibrary(source) ||
      program.isSourceFileFromExternalLibrary(source) ||
      packageDirectory(source.fileName) !== packageRoot
    ) {
      continue;
    }
    for (const specifier of moduleSpecifiers(source)) {
      const missing = missingByName.get(specifierPackage(specifier.text));
      if (missing) imported.add(missing);
    }
  }
  const unimported = uninstalled.filter((name) => !imported.has(name));
  return {
    missingByName,
    unimported,
    gapFile: unimported.length > 0 ? packageGapFile(packageRoot) : null,
  };
}

export function ruleNoRestatedDependencyType() {
  return {
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
        uninstalledImport:
          "{{packageName}} is declared in {{manifest}} but not installed, so object types are not compared with its exports.",
        uninstalledPackage:
          "{{packages}} declared in {{manifest}} are not installed and not imported in this package, so object types are not compared with their exports.",
      },
    },
    create(context) {
      const services = requireTypeServices(context);
      if (!services) {
        return missingTypeServicesVisitors(
          context,
          "no-restated-dependency-type"
        );
      }
      function packageScope() {
        const source = services.program.getSourceFile(context.filename);
        const packageRoot = source && packageDirectory(source.fileName);
        if (!packageRoot) return null;
        const inventory = dependencyInventory(services.program);
        return {
          source,
          packageRoot,
          inventory,
          scope: inventory.ownersByScope.get(packageRoot),
        };
      }
      function reportCoverageGaps() {
        const located = packageScope();
        if (!located || located.scope.missingByName.size === 0) return;
        const { source, packageRoot, scope } = located;
        const manifest = relative(
          context.cwd,
          join(packageRoot, "package.json")
        );
        for (const specifier of moduleSpecifiers(source)) {
          const packageName = scope.missingByName.get(
            specifierPackage(specifier.text)
          );
          if (!packageName) continue;
          const start = source.getLineAndCharacterOfPosition(
            specifier.getStart(source)
          );
          const end = source.getLineAndCharacterOfPosition(specifier.end);
          context.report({
            loc: {
              start: { line: start.line + 1, column: start.character },
              end: { line: end.line + 1, column: end.character },
            },
            messageId: "uninstalledImport",
            data: { packageName, manifest },
          });
        }
        if (scope.gapFile === source.fileName) {
          context.report({
            loc: { line: 1, column: 0 },
            messageId: "uninstalledPackage",
            data: { packages: scope.unimported.join(", "), manifest },
          });
        }
      }
      function check(node) {
        const members =
          node.type === "TSInterfaceDeclaration"
            ? node.body.body
            : node.members;
        if (members.length < 3) return;
        const located = packageScope();
        if (!located) return;
        const { source, packageRoot, inventory, scope } = located;
        const { checker } = inventory;
        const declaration = services.esTreeNodeToTSNodeMap.get(node);
        const type = checker.getTypeAtLocation(declaration);
        const declared =
          ts.isInterfaceDeclaration(declaration) &&
          checker.getSymbolAtLocation(declaration.name);
        const merged = declared && checker.getMergedSymbol(declared);
        const owner = scope.scopes
          .get(source.impliedNodeFormat)
          ?.get(propertyKey(type, checker))
          ?.find(
            (candidate) =>
              candidate.symbol !== merged &&
              candidate.symbol.declarations?.some(
                (ownerDeclaration) =>
                  packageDirectory(
                    ownerDeclaration.getSourceFile().fileName
                  ) !== packageRoot
              ) &&
              sameObjectShape(type, candidate.type, inventory.program)
          );
        if (!owner) return;
        context.report({
          node,
          messageId: "restated",
          data: {
            name: owner.name,
            packageName: owner.packageName,
            specifier: importedName(owner.specifier),
          },
        });
      }
      return {
        Program: reportCoverageGaps,
        TSInterfaceDeclaration: check,
        TSTypeLiteral: check,
      };
    },
  };
}
