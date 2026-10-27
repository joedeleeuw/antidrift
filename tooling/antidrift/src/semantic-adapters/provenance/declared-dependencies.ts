import { dirname, extname, join } from "node:path";
import ts from "typescript";

type PackageManifest = {
  readonly name?: unknown;
  readonly types?: unknown;
  readonly typings?: unknown;
  readonly main?: unknown;
  readonly exports?: unknown;
  readonly dependencies?: unknown;
  readonly devDependencies?: unknown;
  readonly peerDependencies?: unknown;
};

type WildcardMatch = {
  readonly filename: string;
  readonly replacement: string;
};

export const manifestDependencyFields = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
] as const;
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
const typedExtensions = new Set<string>([
  ts.Extension.Dts,
  ts.Extension.Dmts,
  ts.Extension.Dcts,
  ts.Extension.Ts,
  ts.Extension.Tsx,
  ts.Extension.Mts,
  ts.Extension.Cts,
]);

function isPackageManifest(candidate: unknown): candidate is PackageManifest {
  return typeof candidate === "object" && candidate !== null;
}

function readManifest(filename: string): PackageManifest {
  const unreadable = `${filename} is not a readable JSON package manifest`;
  const text = ts.sys.readFile(filename);
  if (text === undefined) {
    throw new Error(unreadable);
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    throw new Error(unreadable, { cause: error });
  }
  if (!isPackageManifest(manifest)) {
    throw new Error(unreadable);
  }
  return manifest;
}

function realPath(path: string): string {
  if (!ts.sys.realpath) {
    throw new Error("The TypeScript system host does not expose realpath");
  }
  return ts.sys.realpath(path);
}

export function packageDirectory(filename: string): string | null {
  let directory = dirname(filename);
  while (!ts.sys.fileExists(join(directory, "package.json"))) {
    const parent = dirname(directory);
    if (parent === directory) {
      return null;
    }
    directory = parent;
  }
  return directory;
}

function resolvedManifest(
  directory: string,
  name: string,
  options: ts.CompilerOptions
): string | null {
  const resolved = ts.resolveModuleName(
    name,
    join(directory, "package.json"),
    options,
    ts.sys
  ).resolvedModule;
  const resolvedRoot = resolved && packageDirectory(resolved.resolvedFileName);
  if (!resolvedRoot) {
    return null;
  }
  const manifestPath = join(resolvedRoot, "package.json");
  return readManifest(manifestPath).name === name ? manifestPath : null;
}

function installedManifest(directory: string, name: string): string | null {
  let current = directory;
  while (
    !ts.sys.fileExists(join(current, "node_modules", name, "package.json"))
  ) {
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
  return join(current, "node_modules", name, "package.json");
}

export function dependencyManifest(
  packageRoot: string,
  name: string,
  options: ts.CompilerOptions
): string | null {
  return (
    installedManifest(packageRoot, name) ??
    resolvedManifest(packageRoot, name, options)
  );
}

export function declaredDependencies(packageRoot: string): string[] {
  const manifest = readManifest(join(packageRoot, "package.json"));
  return [
    ...new Set(
      manifestDependencyFields.flatMap((field) =>
        Object.keys(manifest[field] ?? {})
      )
    ),
  ];
}

export function dependsBack(
  packageRoot: string,
  manifestPath: string
): boolean {
  const { name } = readManifest(join(packageRoot, "package.json"));
  return (
    typeof name === "string" &&
    declaredDependencies(dirname(manifestPath)).includes(name)
  );
}

export function isInstalledPackageManifest(manifestPath: string): boolean {
  return installedArtifact.test(realPath(dirname(manifestPath)));
}

function exportTargets(entry: unknown): string[] {
  if (typeof entry === "string") {
    return [entry];
  }
  if (!entry || typeof entry !== "object") {
    return [];
  }
  return Object.values(entry).flatMap(exportTargets);
}

export function scriptPath(path: string): boolean {
  const extension = extname(path);
  return extension === "" || scriptExtensions.has(extension);
}

function rootEntryDeclared(
  manifest: PackageManifest,
  packageRoot: string
): boolean {
  return (
    [manifest.types, manifest.typings, manifest.main].some(Boolean) ||
    [...scriptExtensions].some((extension) =>
      ts.sys.fileExists(join(packageRoot, `index${extension}`))
    )
  );
}

function wildcardMatches(
  packageRoot: string,
  pattern: string,
  files: readonly string[]
): WildcardMatch[] {
  const [prefix = "", suffix = ""] = join(packageRoot, pattern).split("*");
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

export function matchesSpecifierPattern(
  candidate: string,
  pattern: string
): boolean {
  const [prefix = "", suffix] = pattern.split("*");
  return suffix === undefined
    ? candidate === pattern
    : candidate.length >= prefix.length + suffix.length &&
        candidate.startsWith(prefix) &&
        candidate.endsWith(suffix);
}

function governingEntry(
  entries: readonly string[],
  entryKey: string
): string | undefined {
  if (entries.includes(entryKey)) {
    return entryKey;
  }
  return entries
    .filter(
      (candidate) =>
        candidate.includes("*") && matchesSpecifierPattern(entryKey, candidate)
    )
    .sort(
      (left, right) =>
        right.indexOf("*") - left.indexOf("*") || right.length - left.length
    )[0];
}

function exportsMap(exportsField: unknown) {
  if (
    typeof exportsField === "object" &&
    exportsField !== null &&
    !Array.isArray(exportsField) &&
    Object.keys(exportsField).some((key) => key.startsWith("."))
  ) {
    return exportsField;
  }
  return { ".": exportsField };
}

function scriptFiles(packageRoot: string): string[] {
  return ts.sys
    .readDirectory(packageRoot, undefined, ["node_modules"])
    .filter((filename) => scriptExtensions.has(extname(filename)));
}

export function publicEntries(name: string, manifestPath: string) {
  const manifest = readManifest(manifestPath);
  const packageRoot = dirname(manifestPath);
  const specifiers = new Set<string>();
  const undecided: string[] = [];
  if (manifest.exports === undefined) {
    if (rootEntryDeclared(manifest, packageRoot)) {
      specifiers.add(name);
    }
    return { specifiers: [...specifiers], undecided };
  }
  const exports = exportsMap(manifest.exports);
  let files: string[] | null = null;
  const entries = Object.keys(exports);
  for (const [entry, target] of Object.entries(exports)) {
    const targets = exportTargets(target).filter(scriptPath);
    const subpath = entry === "." ? name : name + entry.slice(1);
    if (targets.length === 0) {
      continue;
    }
    if (!entry.includes("*")) {
      specifiers.add(subpath);
      continue;
    }
    files ??= scriptFiles(packageRoot);
    const packageFiles = files;
    const existing = targets
      .filter((pattern) => pattern.includes("*"))
      .flatMap((pattern) =>
        wildcardMatches(packageRoot, pattern, packageFiles)
      );
    if (existing.length === 0) {
      undecided.push(subpath);
    }
    for (const { replacement } of existing) {
      if (
        governingEntry(
          entries,
          entry.replace("*", () => replacement)
        ) === entry
      ) {
        specifiers.add(subpath.replace("*", () => replacement));
      }
    }
  }
  return { specifiers: [...specifiers], undecided };
}

export function resolvedModule(
  specifier: string,
  containingFile: string,
  options: ts.CompilerOptions,
  mode?: ts.ResolutionMode
): ts.ResolvedModuleFull | undefined {
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

export function createUsageResolver(
  filename: string,
  sourceText: string,
  options: ts.CompilerOptions
) {
  let sourceFile: ts.SourceFile | undefined;
  return (specifier: string, position: number) => {
    const parsedFile = (sourceFile ??= ts.createSourceFile(
      filename,
      sourceText,
      {
        languageVersion: ts.ScriptTarget.Latest,
        impliedNodeFormat: ts.getImpliedNodeFormatForFile(
          filename,
          undefined,
          ts.sys,
          options
        ),
      },
      true
    ));
    let usage: ts.StringLiteralLike | undefined;
    const visit = (node: ts.Node) => {
      if (usage) {
        return;
      }
      if (
        ts.isStringLiteralLike(node) &&
        node.getStart(parsedFile) === position &&
        node.text === specifier
      ) {
        usage = node;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(parsedFile);
    if (!usage) {
      throw new Error(
        `Cannot locate module specifier '${specifier}' at ${filename}:${position} for resolution-mode analysis.`
      );
    }
    return resolvedModule(
      specifier,
      filename,
      options,
      ts.getModeForUsageLocation(parsedFile, usage, options)
    );
  };
}

export function resolvesToTypes(
  specifier: string,
  containingFile: string,
  options: ts.CompilerOptions,
  mode?: ts.ResolutionMode
): boolean {
  const resolved = resolvedModule(specifier, containingFile, options, mode);
  return resolved !== undefined && typedExtensions.has(resolved.extension);
}

export function unresolvedEntries(
  packageRoot: string,
  name: string,
  manifestPath: string,
  options: ts.CompilerOptions
): string[] {
  if (isInstalledPackageManifest(manifestPath)) {
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

export function importedName(packageName: string): string {
  const typesPackage = /^@types\/(.+)$/u.exec(packageName)?.[1];
  if (typesPackage === undefined) {
    return packageName;
  }
  const [scope = "", name] = typesPackage.split("__");
  return name ? `@${scope}/${name}` : scope;
}

export function specifierPackage(specifier: string): string | null {
  if (/^(?:\.|\/|[a-z]+:)/u.test(specifier)) {
    return null;
  }
  return specifier
    .split("/")
    .slice(0, specifier.startsWith("@") ? 2 : 1)
    .join("/");
}

export function governingOptions(packageRoot: string): ts.CompilerOptions {
  const configPath = ts.findConfigFile(packageRoot, ts.sys.fileExists);
  if (!configPath) {
    return {};
  }
  return ts.parseJsonConfigFileContent(
    ts.readConfigFile(configPath, ts.sys.readFile).config,
    ts.sys,
    dirname(configPath),
    undefined,
    configPath
  ).options;
}
