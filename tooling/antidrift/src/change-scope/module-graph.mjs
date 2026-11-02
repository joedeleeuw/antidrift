import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";

import ts from "typescript";

const MAX_GIT_BUFFER = 64 * 1024 * 1024;
const SOURCE_FILE_RE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/u;
const TS_DECLARATION_RE = /\.d\.(?:ts|mts|cts)$/u;

function compareStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function repoPath(cwd, fileName) {
  return relative(cwd, fileName).replace(/\\/gu, "/");
}

function isSourcePath(path) {
  return SOURCE_FILE_RE.test(path) && !TS_DECLARATION_RE.test(path);
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
      `${command} ${args.join(" ")} failed in ${cwd} (status ${result.status}): ${(result.stderr ?? "").trim()}`
    );
  }
  return result.stdout;
}

function resolveConfigPath(baseDir, target) {
  const candidate = resolve(baseDir, target);
  return existsSync(candidate) && candidate.endsWith(".json")
    ? candidate
    : resolve(candidate, "tsconfig.json");
}

function childTsconfigs(configDir, projectReferences) {
  const configs = projectReferences.map((ref) =>
    resolveConfigPath(configDir, ref.path)
  );
  if (projectReferences.length === 0) return configs;
  for (const group of ["apps", "packages", "tooling"]) {
    const groupDir = resolve(configDir, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        configs.push(resolve(groupDir, entry.name, "tsconfig.json"));
      }
    }
  }
  return configs;
}

function declarationSibling(filePath) {
  return TS_DECLARATION_RE.test(filePath)
    ? filePath.replace(/\.d\.(m?c?)ts$/u, ".$1js")
    : null;
}

function implementationFilesFor(fileNames) {
  const results = new Set();
  for (const file of fileNames) {
    const sibling = declarationSibling(file);
    if (sibling === null) results.add(file);
    else if (existsSync(sibling)) results.add(sibling);
  }
  return [...results];
}

function readTsconfig(cwd, tsconfig, visited = new Set()) {
  const configPath = resolveConfigPath(cwd, tsconfig);
  const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
  if (loaded.error) {
    throw new Error(
      `module-graph-radius: could not read ${tsconfig}: ${ts.flattenDiagnosticMessageText(loaded.error.messageText, "\n")}`
    );
  }
  const parsed = ts.parseJsonConfigFileContent(
    loaded.config,
    ts.sys,
    dirname(configPath),
    undefined,
    configPath
  );
  if (parsed.errors.length > 0) {
    throw new Error(
      `module-graph-radius: invalid ${tsconfig}: ${parsed.errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")).join("; ")}`
    );
  }
  visited.add(configPath);
  const rootNames = implementationFilesFor(parsed.fileNames);
  const projects = [{ options: parsed.options, rootNames }];
  for (const ref of childTsconfigs(
    dirname(configPath),
    parsed.projectReferences ?? []
  )) {
    if (!visited.has(ref) && existsSync(ref)) {
      projects.push(
        ...readTsconfig(dirname(configPath), ref, visited).projects
      );
    }
  }
  return { options: parsed.options, projects };
}

function sourceFilesInRepo(program, fileNames, cwd) {
  const byPath = new Map();
  for (const sourceFile of program.getSourceFiles()) {
    if (
      !sourceFile.isDeclarationFile &&
      isSourcePath(sourceFile.fileName) &&
      !repoPath(cwd, sourceFile.fileName).startsWith("../")
    ) {
      byPath.set(repoPath(cwd, sourceFile.fileName), sourceFile);
    }
  }
  for (const fileName of fileNames) {
    if (!isSourcePath(fileName)) continue;
    const rel = repoPath(cwd, fileName);
    if (rel.startsWith("../") || byPath.has(rel)) continue;
    const text = ts.sys.readFile(fileName);
    if (text === undefined) continue;
    byPath.set(
      rel,
      ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true)
    );
  }
  return [...byPath.entries()]
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([, sourceFile]) => sourceFile);
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
  repoRoot,
  specifier,
  sourceFile,
  options,
  sourcePaths,
}) {
  const resolved = ts.resolveModuleName(
    specifier,
    sourceFile.fileName,
    options,
    ts.sys
  ).resolvedModule;
  if (!resolved) {
    if (specifier.startsWith(".")) {
      throw new Error(
        `module-graph-radius: could not resolve ${specifier} from ${sourceFile.fileName}`
      );
    }
    return null;
  }
  const target = resolved.resolvedFileName;
  const files =
    existsSync(target) && realpathSync(target) !== target
      ? [target, realpathSync(target)]
      : [target];
  for (const file of files) {
    for (const root of repoRoot ? [cwd, repoRoot] : [cwd]) {
      const rel = repoPath(root, file);
      if (sourcePaths.has(rel)) return rel;
      const sibling = declarationSibling(rel);
      if (sibling !== null && sourcePaths.has(sibling)) return sibling;
    }
  }
  return null;
}

function importTargets({ cwd, repoRoot, sourceFile, options, sourcePaths }) {
  const targets = [];
  function visit(node) {
    const specifier = moduleSpecifierFor(node);
    if (specifier !== null) {
      const target = resolveInternalModule({
        cwd,
        repoRoot,
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
    .filter((file) => isSourcePath(file.path))
    .map((file) => ({
      path: file.path.replace(/\\/gu, "/"),
      operation: file.operation,
      oldPath: file.oldPath ? file.oldPath.replace(/\\/gu, "/") : null,
    }))
    .sort((left, right) => compareStrings(left.path, right.path));
}

function touchedEntry({ file, graph, distances, maxTouchedModuleRadius }) {
  if (file.operation === "delete") {
    return { ...file, distance: null, withinRadius: null, reason: "deleted" };
  }
  if (!graph.has(file.path)) {
    throw new Error(
      `module-graph-radius: changed TypeScript file ${file.path} is not included by the selected tsconfig`
    );
  }
  const distance = distances.get(file.path) ?? null;
  const withinRadius =
    typeof maxTouchedModuleRadius === "number"
      ? distance !== null && distance <= maxTouchedModuleRadius
      : null;
  const reason = distance === null ? "unreachable-from-entrypoint" : null;
  return { ...file, distance, withinRadius, reason };
}

function withHeadTree({ cwd, head }, inspectTree) {
  const repoRoot = resolve(cwd);
  const temp = mkdtempSync(resolve(tmpdir(), "module-graph-head-"));
  const treeRoot = resolve(temp, "tree");
  const archivePath = resolve(temp, "head.tar");
  try {
    mkdirSync(treeRoot);
    const archiveArgs = [
      "archive",
      "--format=tar",
      `--output=${archivePath}`,
      head,
    ];
    runOrThrow("git", archiveArgs, repoRoot);
    runOrThrow("tar", ["-xf", archivePath, "-C", treeRoot], repoRoot);
    const repoModules = resolve(repoRoot, "node_modules");
    const treeModules = resolve(treeRoot, "node_modules");
    if (existsSync(repoModules) && !existsSync(treeModules)) {
      symlinkSync(repoModules, treeModules, "junction");
    }
    return inspectTree(treeRoot, repoRoot);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function collectProjectSources(treeRoot, parsed) {
  const byPath = new Map();
  const optionsByPath = new Map();
  for (const { options, rootNames } of parsed.projects) {
    if (rootNames.length === 0) continue;
    const projectOptions = { ...options, allowJs: true, noEmit: true };
    const program = ts.createProgram({ rootNames, options: projectOptions });
    for (const sf of sourceFilesInRepo(program, rootNames, treeRoot)) {
      const rel = repoPath(treeRoot, sf.fileName);
      byPath.set(rel, sf);
      optionsByPath.set(rel, projectOptions);
    }
  }
  const sourceFiles = [...byPath.entries()]
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([, sf]) => sf);
  return { sourceFiles, optionsByPath };
}

function importGraph(treeRoot, repoRoot, tsconfig) {
  const parsed = readTsconfig(treeRoot, tsconfig);
  const { sourceFiles, optionsByPath } = collectProjectSources(
    treeRoot,
    parsed
  );
  const graph = new Map();
  const sourcePaths = new Set(
    sourceFiles.map((sourceFile) => repoPath(treeRoot, sourceFile.fileName))
  );
  for (const sourcePath of sourcePaths) addNode(graph, sourcePath);
  for (const sourceFile of sourceFiles) {
    const from = repoPath(treeRoot, sourceFile.fileName);
    for (const to of importTargets({
      cwd: treeRoot,
      repoRoot,
      sourceFile,
      options: optionsByPath.get(from) ?? parsed.options,
      sourcePaths,
    })) {
      addEdge(graph, from, to);
    }
  }
  return graph;
}

function checkedEntrypoints(allowedEntrypoints, graph) {
  const entrypoints = allowedEntrypoints
    .map((path) => path.replace(/\\/gu, "/"))
    .sort(compareStrings);
  const missingEntrypoints = entrypoints.filter(
    (entrypoint) => !graph.has(entrypoint)
  );
  if (missingEntrypoints.length > 0) {
    throw new Error(
      `module-graph-radius: scope.allowedEntrypoints missing from selected tsconfig: ${missingEntrypoints.join(", ")}`
    );
  }
  return entrypoints;
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
      "module-graph-radius: --tsconfig is required when scope.allowedEntrypoints is configured"
    );
  }
  const graph = withHeadTree({ cwd, head }, (treeRoot, repoRoot) =>
    importGraph(treeRoot, repoRoot, tsconfig)
  );
  const entrypoints = checkedEntrypoints(allowedEntrypoints, graph);
  const distances = shortestDistances(graph, entrypoints);
  const touchedFiles = touchedTsFiles(changedFiles).map((file) =>
    touchedEntry({ file, graph, distances, maxTouchedModuleRadius })
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
