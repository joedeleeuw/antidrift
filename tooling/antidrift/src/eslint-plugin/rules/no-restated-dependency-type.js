import { dirname, join } from "node:path";
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
    const manifestPath = dependencyManifest(packageRoot, dependency);
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
    ownersByScope.set(packageRoot, { scopes, uninstalled });
  }
  const inventory = { checker, ownersByScope };
  inventoryByProgram.set(program, inventory);
  return inventory;
}

function augmentedPackage(declaration) {
  for (let node = declaration.parent; node; node = node.parent) {
    if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) {
      const segments = node.name.text.split("/");
      return segments
        .slice(0, node.name.text.startsWith("@") ? 2 : 1)
        .join("/");
    }
  }
  return null;
}

function importedName(packageName) {
  const typesPackage = /^@types\/(.+)$/u.exec(packageName);
  if (!typesPackage) return packageName;
  const [scope, name] = typesPackage[1].split("__");
  return name ? `@${scope}/${name}` : scope;
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
        uninstalled:
          "{{packages}} declared in {{manifest}} are not installed, so this file's object types were not compared with their exports.",
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
      let gapReported = false;
      function check(node) {
        const members =
          node.type === "TSInterfaceDeclaration"
            ? node.body.body
            : node.members;
        if (members.length < 3) return;
        const declaration = services.esTreeNodeToTSNodeMap.get(node);
        const source = declaration.getSourceFile();
        const packageRoot = packageDirectory(source.fileName);
        if (packageRoot === null) return;
        const { checker, ownersByScope } = dependencyInventory(
          services.program
        );
        const { scopes, uninstalled } = ownersByScope.get(packageRoot);
        if (uninstalled.length > 0 && !gapReported) {
          gapReported = true;
          context.report({
            loc: { line: 1, column: 0 },
            messageId: "uninstalled",
            data: {
              packages: uninstalled.join(", "),
              manifest: join(packageRoot, "package.json"),
            },
          });
        }
        const type = checker.getTypeAtLocation(declaration);
        const augmented = augmentedPackage(declaration);
        const owner = scopes
          .get(source.impliedNodeFormat)
          ?.get(propertyKey(type, checker))
          ?.find(
            (candidate) =>
              candidate.type !== type &&
              augmented !== candidate.packageName &&
              augmented !== importedName(candidate.packageName) &&
              sameObjectShape(type, candidate.type, checker)
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
        TSInterfaceDeclaration: check,
        TSTypeLiteral: check,
      };
    },
  };
}
