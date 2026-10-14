import { dirname, extname, join } from "node:path";
import ts from "typescript";
import { packageDirectory } from "./shape-identity.mjs";

export const manifestDependencyFields = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
];
const installedArtifact = /(?:^|[/\\])node_modules[/\\]/u;
const scriptExtensions = new Set([
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
]);
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

function installedManifest(directory, name) {
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

export function dependencyManifest(packageRoot, name, options) {
  return (
    installedManifest(packageRoot, name) ??
    resolvedManifest(packageRoot, name, options)
  );
}

export function declaredDependencies(packageRoot) {
  const manifest = readManifest(join(packageRoot, "package.json"));
  return [
    ...new Set(
      manifestDependencyFields.flatMap((field) =>
        Object.keys(manifest[field] ?? {})
      )
    ),
  ];
}

export function dependsBack(packageRoot, manifestPath) {
  const { name } = readManifest(join(packageRoot, "package.json"));
  return (
    typeof name === "string" &&
    declaredDependencies(dirname(manifestPath)).includes(name)
  );
}

function exportTargets(entry) {
  if (typeof entry === "string") return [entry];
  if (!entry || typeof entry !== "object") return [];
  return Object.values(entry).flatMap(exportTargets);
}

function scriptPath(path) {
  const extension = extname(path);
  return extension === "" || scriptExtensions.has(extension);
}

function rootEntryDeclared(manifest, packageRoot) {
  return (
    [manifest.types, manifest.typings, manifest.main].some(Boolean) ||
    [...scriptExtensions].some((extension) =>
      ts.sys.fileExists(join(packageRoot, `index${extension}`))
    )
  );
}

function wildcardMatches(packageRoot, pattern, files) {
  const [prefix, suffix] = join(packageRoot, pattern).split("*");
  return files
    .filter(
      (filename) =>
        filename.length > prefix.length + suffix.length &&
        filename.startsWith(prefix) &&
        filename.endsWith(suffix)
    )
    .map((filename) => ({
      filename,
      replacement: filename.slice(
        prefix.length,
        filename.length - suffix.length
      ),
    }));
}

function governingEntry(entries, entryKey) {
  if (entries.includes(entryKey)) return entryKey;
  return entries
    .filter((candidate) => {
      const [prefix, suffix] = candidate.split("*");
      return (
        suffix !== undefined &&
        entryKey.length >= prefix.length + suffix.length &&
        entryKey.startsWith(prefix) &&
        entryKey.endsWith(suffix)
      );
    })
    .sort(
      (left, right) =>
        right.indexOf("*") - left.indexOf("*") || right.length - left.length
    )[0];
}

export function publicEntries(name, manifestPath) {
  const manifest = readManifest(manifestPath);
  const packageRoot = dirname(manifestPath);
  const specifiers = new Set();
  const undecided = [];
  if (manifest.exports === undefined) {
    if (rootEntryDeclared(manifest, packageRoot)) specifiers.add(name);
  } else {
    const exports =
      typeof manifest.exports === "object" &&
      manifest.exports !== null &&
      !Array.isArray(manifest.exports) &&
      Object.keys(manifest.exports).some((key) => key.startsWith("."))
        ? manifest.exports
        : { ".": manifest.exports };
    let files = null;
    const entries = Object.keys(exports);
    for (const [entry, target] of Object.entries(exports)) {
      const targets = exportTargets(target).filter(scriptPath);
      if (targets.length === 0) continue;
      const subpath = entry === "." ? name : name + entry.slice(1);
      if (!entry.includes("*")) {
        specifiers.add(subpath);
        continue;
      }
      files ??= ts.sys
        .readDirectory(packageRoot, undefined, ["node_modules"])
        .filter((filename) => scriptExtensions.has(extname(filename)));
      const existing = targets
        .filter((pattern) => pattern.includes("*"))
        .flatMap((pattern) => wildcardMatches(packageRoot, pattern, files));
      if (existing.length === 0) undecided.push(subpath);
      for (const { replacement } of existing) {
        const governed = entry.replace("*", () => replacement);
        if (governingEntry(entries, governed) === entry) {
          specifiers.add(subpath.replace("*", () => replacement));
        }
      }
    }
  }
  return { specifiers: [...specifiers], undecided };
}

export function resolvedModule(specifier, containingFile, options, mode) {
  return ts.resolveModuleName(
    specifier,
    containingFile,
    options,
    ts.sys,
    undefined,
    undefined,
    mode
  ).resolvedModule;
}

export function resolvesToTypes(specifier, containingFile, options, mode) {
  const resolved = resolvedModule(specifier, containingFile, options, mode);
  return Boolean(resolved) && typedExtensions.has(resolved.extension);
}

export function unresolvedEntries(packageRoot, name, manifestPath, options) {
  if (installedArtifact.test(ts.sys.realpath(dirname(manifestPath)))) {
    return [];
  }
  const { specifiers, undecided } = publicEntries(name, manifestPath);
  return [
    ...specifiers.filter(
      (specifier) =>
        !resolvesToTypes(specifier, join(packageRoot, "package.json"), options)
    ),
    ...undecided,
  ];
}

export function importedName(packageName) {
  const typesPackage = /^@types\/(.+)$/u.exec(packageName);
  if (!typesPackage) return packageName;
  const [scope, name] = typesPackage[1].split("__");
  return name ? `@${scope}/${name}` : scope;
}

export function specifierPackage(specifier) {
  if (/^(?:\.|\/|[a-z]+:)/u.test(specifier)) return null;
  return specifier
    .split("/")
    .slice(0, specifier.startsWith("@") ? 2 : 1)
    .join("/");
}

export function scriptSpecifier(specifier, packageName) {
  return scriptPath(specifier.slice(packageName.length));
}

export function governingOptions(packageRoot) {
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
