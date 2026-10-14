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
const installedArtifact = /(?:^|[/\\])node_modules[/\\]/u;
const ownerSymbols = ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias;
const typedExtensions = new Set([
  ts.Extension.Dts,
  ts.Extension.Dmts,
  ts.Extension.Dcts,
  ts.Extension.Ts,
  ts.Extension.Tsx,
  ts.Extension.Mts,
  ts.Extension.Cts,
]);

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

function declaresTypes(target) {
  if (!target || typeof target !== "object") return false;
  return Object.entries(target).some(
    ([condition, conditionTarget]) =>
      condition === "types" ||
      condition === "typings" ||
      declaresTypes(conditionTarget)
  );
}

function typedEntries(name, manifest) {
  if (!manifest.exports) {
    return manifest.types || manifest.typings ? [name] : [];
  }
  const exports =
    typeof manifest.exports === "object" &&
    !Array.isArray(manifest.exports) &&
    Object.keys(manifest.exports).some((key) => key.startsWith("."))
      ? manifest.exports
      : { ".": manifest.exports };
  return Object.entries(exports)
    .filter(([entry, target]) => !entry.includes("*") && declaresTypes(target))
    .map(([entry]) => (entry === "." ? name : name + entry.slice(1)));
}

function resolvesToTypes(specifier, containingFile, options, mode) {
  const resolved = ts.resolveModuleName(
    specifier,
    containingFile,
    options,
    ts.sys,
    undefined,
    undefined,
    mode
  ).resolvedModule;
  return Boolean(resolved) && typedExtensions.has(resolved.extension);
}

function dependencyStatus(packageRoot, dependency, options) {
  const manifestPath =
    dependencyManifest(packageRoot, dependency) ??
    resolvedManifest(packageRoot, dependency, options);
  if (!manifestPath) return { dependency, manifestPath, unresolvedEntries: [] };
  const manifest = readManifest(manifestPath);
  if (installedArtifact.test(ts.sys.realpath(dirname(manifestPath)))) {
    return { dependency, manifestPath, unresolvedEntries: [] };
  }
  return {
    dependency,
    manifestPath,
    unresolvedEntries: typedEntries(dependency, manifest).filter(
      (specifier) =>
        !resolvesToTypes(specifier, join(packageRoot, "package.json"), options)
    ),
  };
}

function declaredDependencies(packageRoot) {
  const manifest = readManifest(join(packageRoot, "package.json"));
  return [
    ...new Set(
      manifestDependencyFields.flatMap((field) =>
        Object.keys(manifest[field] ?? {})
      )
    ),
  ];
}

function packageEntries(packageRoot, modes, options, entriesByManifest) {
  const uninstalled = [];
  const installed = [];
  const entries = [];
  for (const dependency of declaredDependencies(packageRoot)) {
    const { manifestPath } = dependencyStatus(packageRoot, dependency, options);
    if (!manifestPath) {
      uninstalled.push(dependency);
      continue;
    }
    installed.push(dependency);
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
  return { entries, uninstalled, installed };
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
  for (const [packageRoot, { entries, uninstalled, installed }] of packages) {
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
      missingByName: dependencyNames(uninstalled),
      installedByName: dependencyNames(installed),
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

function dependencyNames(packageNames) {
  return new Map(
    packageNames.flatMap((packageName) => [
      [packageName, packageName],
      [importedName(packageName), packageName],
    ])
  );
}

function bindsModule(specifier) {
  const holder = specifier.parent;
  return !(ts.isImportDeclaration(holder) && !holder.importClause);
}

function governingOptions(packageRoot) {
  const configPath = ts.findConfigFile(packageRoot, ts.sys.fileExists);
  if (!configPath) return {};
  return ts.parseJsonConfigFileContent(
    ts.readConfigFile(configPath, ts.sys.readFile).config,
    ts.sys,
    dirname(configPath),
    undefined,
    configPath
  ).options;
}

function manifestVisitors(context) {
  const packageRoot = dirname(context.filename);
  const options = governingOptions(packageRoot);
  return {
    Document(node) {
      if (node.body.type !== "Object") return;
      for (const field of node.body.members) {
        if (
          !manifestDependencyFields.includes(field.name.value) ||
          field.value.type !== "Object"
        ) {
          continue;
        }
        for (const member of field.value.members) {
          const status = dependencyStatus(
            packageRoot,
            member.name.value,
            options
          );
          if (!status.manifestPath) {
            context.report({
              node: member.name,
              messageId: "uninstalledManifest",
              data: { packageName: status.dependency },
            });
          } else if (status.unresolvedEntries.length > 0) {
            context.report({
              node: member.name,
              messageId: "unresolvedEntry",
              data: {
                packageName: status.dependency,
                entries: status.unresolvedEntries.join(", "),
              },
            });
          }
        }
      }
    },
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
        unresolvedImport:
          "{{packageName}} is installed but '{{specifier}}' does not resolve to type declarations, so object types are not compared with its exports.",
        uninstalledManifest:
          "{{packageName}} is declared here but not installed, so object types in this package are not compared with its exports.",
        unresolvedEntry:
          "{{packageName}} is a workspace or linked package whose declared type entries {{entries}} do not resolve, so object types in this package are not compared with their exports.",
      },
    },
    create(context) {
      if (context.sourceCode.ast.type === "Document") {
        return manifestVisitors(context);
      }
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
      function moduleResolves(specifier, source) {
        const holder = specifier.parent;
        if (
          ts.isCallExpression(holder) &&
          ts.isIdentifier(holder.expression) &&
          holder.expression.text === "require" &&
          !ts.isInJSFile(holder)
        ) {
          return resolvesToTypes(
            specifier.text,
            source.fileName,
            services.program.getCompilerOptions(),
            source.impliedNodeFormat
          );
        }
        return Boolean(
          services.program.getTypeChecker().getSymbolAtLocation(specifier)
        );
      }
      function reportCoverageGaps() {
        const located = packageScope();
        if (!located) return;
        const { source, packageRoot, scope } = located;
        const manifest = relative(
          context.cwd,
          join(packageRoot, "package.json")
        );
        for (const specifier of moduleSpecifiers(source)) {
          const imported = specifierPackage(specifier.text);
          const missing = scope.missingByName.get(imported);
          const installed = scope.installedByName.get(imported);
          let report = null;
          if (missing) {
            report = {
              messageId: "uninstalledImport",
              data: { packageName: missing, manifest },
            };
          } else if (
            installed &&
            bindsModule(specifier) &&
            !moduleResolves(specifier, source)
          ) {
            report = {
              messageId: "unresolvedImport",
              data: { packageName: installed, specifier: specifier.text },
            };
          }
          if (!report) continue;
          const start = source.getLineAndCharacterOfPosition(
            specifier.getStart(source)
          );
          const end = source.getLineAndCharacterOfPosition(specifier.end);
          context.report({
            loc: {
              start: { line: start.line + 1, column: start.character },
              end: { line: end.line + 1, column: end.character },
            },
            ...report,
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
