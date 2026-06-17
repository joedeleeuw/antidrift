import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";

import ts from "typescript";

const MAX_GIT_BUFFER = 64 * 1024 * 1024;
const TS_SOURCE_RE = /\.(?:ts|tsx|mts|cts)$/u;
const TS_DECLARATION_RE = /\.d\.(?:ts|mts|cts)$/u;

function compareStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function normalizePath(path) {
  return path.replace(/\\/gu, "/");
}

function repoPath(cwd, fileName) {
  return normalizePath(relative(cwd, fileName));
}

function isTsSourcePath(path) {
  return TS_SOURCE_RE.test(path) && !TS_DECLARATION_RE.test(path);
}

function gitOrThrow(args, cwd) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: MAX_GIT_BUFFER,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed in ${cwd} (status ${result.status}): ${(result.stderr ?? "").trim()}`,
    );
  }
  return result.stdout;
}

function runOrThrow(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: MAX_GIT_BUFFER,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed in ${cwd} (status ${result.status}): ${(result.stderr ?? "").trim()}`,
    );
  }
}

function withMaterializedGitTree({ cwd, head }, callback) {
  const temp = mkdtempSync(resolve(tmpdir(), "module-graph-head-"));
  const treeRoot = resolve(temp, "tree");
  const archivePath = resolve(temp, "head.tar");
  mkdirSync(treeRoot);
  try {
    gitOrThrow(
      ["archive", "--format=tar", `--output=${archivePath}`, head],
      cwd,
    );
    runOrThrow("tar", ["-xf", archivePath, "-C", treeRoot], cwd);
    return callback(treeRoot);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function diagnosticText(diagnostic) {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
}

function readTsconfig(cwd, tsconfig) {
  const configPath = resolve(cwd, tsconfig);
  const loaded = ts.readConfigFile(configPath, (fileName) =>
    ts.sys.readFile(fileName),
  );
  if (loaded.error) {
    throw new Error(
      `module-graph-radius: could not read ${tsconfig}: ${diagnosticText(loaded.error)}`,
    );
  }
  const parsed = ts.parseJsonConfigFileContent(
    loaded.config,
    ts.sys,
    dirname(configPath),
    undefined,
    configPath,
  );
  if (parsed.errors.length > 0) {
    throw new Error(
      `module-graph-radius: invalid ${tsconfig}: ${parsed.errors.map(diagnosticText).join("; ")}`,
    );
  }
  return parsed;
}

function sourceFilesInRepo(program, cwd) {
  return program
    .getSourceFiles()
    .filter(
      (sourceFile) =>
        !sourceFile.isDeclarationFile &&
        isTsSourcePath(sourceFile.fileName) &&
        !repoPath(cwd, sourceFile.fileName).startsWith("../"),
    )
    .sort((left, right) =>
      compareStrings(
        repoPath(cwd, left.fileName),
        repoPath(cwd, right.fileName),
      ),
    );
}

function stringLiteralText(node) {
  return ts.isStringLiteralLike(node) ? node.text : null;
}

function moduleSpecifierFor(node) {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier
  ) {
    return stringLiteralText(node.moduleSpecifier);
  }
  if (
    ts.isCallExpression(node) &&
    node.expression.kind === ts.SyntaxKind.ImportKeyword
  ) {
    return stringLiteralText(node.arguments[0]);
  }
  return null;
}

function addNode(graph, path) {
  if (!graph.has(path)) graph.set(path, new Set());
}

function addEdge(graph, from, to) {
  addNode(graph, from);
  addNode(graph, to);
  graph.get(from).add(to);
  graph.get(to).add(from);
}

function resolveInternalModule({
  cwd,
  specifier,
  sourceFile,
  options,
  sourcePaths,
}) {
  const resolved = ts.resolveModuleName(
    specifier,
    sourceFile.fileName,
    options,
    ts.sys,
  ).resolvedModule;
  if (!resolved) {
    if (specifier.startsWith(".")) {
      throw new Error(
        `module-graph-radius: could not resolve ${specifier} from ${sourceFile.fileName}`,
      );
    }
    return null;
  }
  if (resolved.isExternalLibraryImport) return null;
  const path = repoPath(cwd, resolved.resolvedFileName);
  return sourcePaths.has(path) ? path : null;
}

function importTargets({ cwd, sourceFile, options, sourcePaths }) {
  const targets = [];
  function visit(node) {
    const specifier = moduleSpecifierFor(node);
    if (specifier !== null) {
      const target = resolveInternalModule({
        cwd,
        specifier,
        sourceFile,
        options,
        sourcePaths,
      });
      if (target !== null) targets.push(target);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return targets.sort(compareStrings);
}

function shortestDistances(graph, entrypoints) {
  const distances = new Map();
  const queue = [];
  for (const entrypoint of entrypoints) {
    distances.set(entrypoint, 0);
    queue.push(entrypoint);
  }
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    const nextDistance = distances.get(current) + 1;
    for (const target of graph.get(current) ?? []) {
      if (distances.has(target)) continue;
      distances.set(target, nextDistance);
      queue.push(target);
    }
  }
  return distances;
}

function edgeCount(graph) {
  let directed = 0;
  for (const targets of graph.values()) directed += targets.size;
  return directed / 2;
}

function touchedTsFiles(changedFiles) {
  return changedFiles
    .filter((file) => isTsSourcePath(file.path))
    .map((file) => ({
      path: normalizePath(file.path),
      operation: file.operation,
      oldPath: file.oldPath ? normalizePath(file.oldPath) : null,
    }))
    .sort((left, right) => compareStrings(left.path, right.path));
}

function touchedEntry({ file, graph, distances, maxTouchedModuleRadius }) {
  if (file.operation === "delete") {
    return {
      ...file,
      distance: null,
      withinRadius: null,
      reason: "deleted",
    };
  }
  if (!graph.has(file.path)) {
    throw new Error(
      `module-graph-radius: changed TypeScript file ${file.path} is not included by the selected tsconfig`,
    );
  }
  const distance = distances.get(file.path) ?? null;
  const withinRadius =
    typeof maxTouchedModuleRadius === "number"
      ? distance !== null && distance <= maxTouchedModuleRadius
      : null;
  return {
    ...file,
    distance,
    withinRadius,
    reason: distance === null ? "unreachable-from-entrypoint" : null,
  };
}

export function collectTouchedModuleGraph({
  cwd,
  head,
  tsconfig,
  changedFiles,
  allowedEntrypoints,
  maxTouchedModuleRadius = null,
}) {
  if (!head) {
    throw new Error("module-graph-radius: head ref is required");
  }
  if (!tsconfig) {
    throw new Error(
      "module-graph-radius: --tsconfig is required when scope.allowedEntrypoints is configured",
    );
  }
  return withMaterializedGitTree({ cwd, head }, (headRoot) =>
    collectTouchedModuleGraphFromDirectory({
      cwd: headRoot,
      head,
      tsconfig,
      changedFiles,
      allowedEntrypoints,
      maxTouchedModuleRadius,
    }),
  );
}

function collectTouchedModuleGraphFromDirectory({
  cwd,
  head,
  tsconfig,
  changedFiles,
  allowedEntrypoints,
  maxTouchedModuleRadius = null,
}) {
  const parsed = readTsconfig(cwd, tsconfig);
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: { ...parsed.options, noEmit: true },
  });
  const sourceFiles = sourceFilesInRepo(program, cwd);
  const graph = new Map();
  const sourcePaths = new Set(
    sourceFiles.map((sourceFile) => repoPath(cwd, sourceFile.fileName)),
  );
  for (const sourcePath of sourcePaths) addNode(graph, sourcePath);
  for (const sourceFile of sourceFiles) {
    const from = repoPath(cwd, sourceFile.fileName);
    for (const to of importTargets({
      cwd,
      sourceFile,
      options: parsed.options,
      sourcePaths,
    })) {
      addEdge(graph, from, to);
    }
  }
  const entrypoints = allowedEntrypoints
    .map(normalizePath)
    .sort(compareStrings);
  const missingEntrypoints = entrypoints.filter(
    (entrypoint) => !graph.has(entrypoint),
  );
  if (missingEntrypoints.length > 0) {
    throw new Error(
      `module-graph-radius: scope.allowedEntrypoints missing from selected tsconfig: ${missingEntrypoints.join(", ")}`,
    );
  }
  const distances = shortestDistances(graph, entrypoints);
  const touchedFiles = touchedTsFiles(changedFiles).map((file) =>
    touchedEntry({ file, graph, distances, maxTouchedModuleRadius }),
  );
  const outOfRadius =
    typeof maxTouchedModuleRadius === "number"
      ? touchedFiles.filter((file) => file.withinRadius === false)
      : [];
  return {
    tsconfig,
    head,
    entrypoints,
    maxTouchedModuleRadius,
    nodes: graph.size,
    edges: edgeCount(graph),
    touchedFiles,
    outOfRadius,
  };
}
