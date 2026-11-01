import { spawnSync } from "node:child_process";
import { dirname, normalize } from "node:path/posix";

import ts from "typescript";

const MAX_GIT_BUFFER = 64 * 1024 * 1024;
const TS_PROGRAM_RE = /\.(?:ts|tsx|mts|cts)$/u;
const SOURCE_SUFFIXES = [
  ".d.mts",
  ".d.cts",
  ".d.ts",
  ".mts",
  ".cts",
  ".tsx",
  ".ts",
];
const SOURCE_EXTENSIONS = new Map([
  [".d.mts", ts.Extension.Dmts],
  [".d.cts", ts.Extension.Dcts],
  [".d.ts", ts.Extension.Dts],
  [".mts", ts.Extension.Mts],
  [".cts", ts.Extension.Cts],
  [".tsx", ts.Extension.Tsx],
  [".ts", ts.Extension.Ts],
]);
const JS_SPECIFIER_SUBSTITUTIONS = new Map([
  [".js", [".ts", ".tsx", ".d.ts"]],
  [".jsx", [".tsx", ".ts", ".d.ts"]],
  [".mjs", [".mts", ".d.mts"]],
  [".cjs", [".cts", ".d.cts"]],
]);

function gitFileAt({ ref, path, cwd }) {
  const result = spawnSync("git", ["show", `${ref}:${path}`], {
    cwd,
    encoding: "utf8",
    maxBuffer: MAX_GIT_BUFFER,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim();
    if (/does not exist in|but not in/iu.test(stderr)) return null;
    throw new Error(
      `git show ${ref}:${path} failed in ${cwd} (status ${result.status}): ${stderr}`
    );
  }
  return result.stdout;
}

export function gitPathsAt({ ref, cwd }) {
  const result = spawnSync("git", ["ls-tree", "-r", "--name-only", ref], {
    cwd,
    encoding: "utf8",
    maxBuffer: MAX_GIT_BUFFER,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `git ls-tree ${ref} failed in ${cwd} (status ${result.status}): ${(result.stderr ?? "").trim()}`
    );
  }
  return result.stdout
    .split("\n")
    .filter((path) => TS_PROGRAM_RE.test(path))
    .sort();
}

function extensionForFileName(fileName) {
  for (const [suffix, extension] of SOURCE_EXTENSIONS) {
    if (fileName.endsWith(suffix)) return extension;
  }
  throw new Error(`unsupported TypeScript source extension for ${fileName}`);
}

function sourceCandidatesFor(moduleName, containingFile) {
  const base = normalize(`${dirname(containingFile)}/${moduleName}`);
  if (SOURCE_SUFFIXES.some((suffix) => base.endsWith(suffix))) return [base];
  for (const [specifierSuffix, sourceSuffixes] of JS_SPECIFIER_SUBSTITUTIONS) {
    if (base.endsWith(specifierSuffix)) {
      const withoutSuffix = base.slice(0, -specifierSuffix.length);
      return sourceSuffixes.map(
        (sourceSuffix) => `${withoutSuffix}${sourceSuffix}`
      );
    }
  }
  return [
    ...SOURCE_SUFFIXES.map((suffix) => `${base}${suffix}`),
    ...SOURCE_SUFFIXES.map((suffix) => `${base}/index${suffix}`),
  ];
}

function resolveRelativeSourceModule(moduleName, containingFile, fileNameSet) {
  if (!moduleName.startsWith(".")) return undefined;
  const resolvedFileName = sourceCandidatesFor(moduleName, containingFile).find(
    (candidate) => fileNameSet.has(candidate)
  );
  if (resolvedFileName === undefined) return undefined;
  return {
    resolvedFileName,
    extension: extensionForFileName(resolvedFileName),
    isExternalLibraryImport: false,
  };
}

function gitSourceReader({ ref, cwd, fileNameSet }) {
  const sourceCache = new Map();
  return (candidate) => {
    if (!fileNameSet.has(candidate)) return undefined;
    if (!sourceCache.has(candidate)) {
      const sourceText = gitFileAt({
        ref,
        path: candidate.slice(1),
        cwd,
      });
      if (sourceText === null) {
        throw new Error(
          `git tree listed ${candidate.slice(1)} at ${ref}, but git show could not read it`
        );
      }
      sourceCache.set(candidate, sourceText);
    }
    return sourceCache.get(candidate);
  };
}

function sourceFileGetter(defaultHost, sourceTextFor) {
  return (candidate, languageVersion, onError, shouldCreateNewSourceFile) => {
    const sourceText = sourceTextFor(candidate);
    if (sourceText !== undefined) {
      return ts.createSourceFile(candidate, sourceText, languageVersion, true);
    }
    return defaultHost.getSourceFile(
      candidate,
      languageVersion,
      onError,
      shouldCreateNewSourceFile
    );
  };
}

export function compilerHostFor({ ref, cwd, fileNames, options }) {
  const defaultHost = ts.createCompilerHost(options, true);
  const fileNameSet = new Set(fileNames);
  const sourceTextFor = gitSourceReader({ ref, cwd, fileNameSet });
  return {
    ...defaultHost,
    getCurrentDirectory() {
      return "/";
    },
    fileExists(candidate) {
      return fileNameSet.has(candidate) || defaultHost.fileExists(candidate);
    },
    readFile(candidate) {
      return sourceTextFor(candidate) ?? defaultHost.readFile(candidate);
    },
    resolveModuleNames(moduleNames, containingFile) {
      return moduleNames.map(
        (moduleName) =>
          resolveRelativeSourceModule(
            moduleName,
            containingFile,
            fileNameSet
          ) ??
          ts.resolveModuleName(moduleName, containingFile, options, defaultHost)
            .resolvedModule
      );
    },
    getSourceFile: sourceFileGetter(defaultHost, sourceTextFor),
  };
}

export function exportModuleSpecifiers(sourceFile) {
  const moduleNames = [];
  function visit(node) {
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      moduleNames.push(node.moduleSpecifier.text);
    }
    ts.forEachChild(node, visit);
  }
  for (const statement of sourceFile.statements) {
    visit(statement);
  }
  return moduleNames;
}

export function affectedExportFileNames({
  ref,
  cwd,
  fileNames,
  seedFileNames,
}) {
  const fileNameSet = new Set(fileNames);
  const affected = new Set(
    seedFileNames.filter((fileName) => fileNameSet.has(fileName))
  );
  let addedAffectedFile = true;
  while (addedAffectedFile) {
    addedAffectedFile = false;
    for (const fileName of fileNames) {
      if (affected.has(fileName)) continue;
      const sourceText = gitFileAt({ ref, path: fileName.slice(1), cwd });
      if (sourceText === null) continue;
      const sourceFile = ts.createSourceFile(
        fileName,
        sourceText,
        ts.ScriptTarget.ESNext,
        true
      );
      const targets = exportModuleSpecifiers(sourceFile)
        .filter((moduleName) => moduleName.startsWith("."))
        .map((moduleName) =>
          resolveRelativeSourceModule(moduleName, fileName, fileNameSet)
        )
        .filter((resolvedModule) => resolvedModule !== undefined)
        .map((resolvedModule) => resolvedModule.resolvedFileName);
      if (targets.some((target) => affected.has(target))) {
        affected.add(fileName);
        addedAffectedFile = true;
      }
    }
  }
  return affected;
}
