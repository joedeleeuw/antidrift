import { existsSync, readFileSync } from "node:fs";
import { posix } from "node:path";

import {
  compilerOutputs,
  declaredBuildInputs,
  exportTarget,
  moduleExportTargets,
  packageSources,
} from "./typescript-engine.js";

const packageSurfaces = new WeakMap();

const ENTRY_FIELDS = ["main", "module", "types", "typings", "browser", "bin"];
const SCRIPT_ENTRY = /(?:\.[cm]?[jt]sx?|\/[^./]*)$/u;
const SOURCE_EXTENSION = /\.[cm]?tsx?$/u;
const OUTPUT_EXTENSION = /(?:\.d)?\.[cm]?[jt]sx?$/u;
const SCRIPT_RUNNERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const SCRIPT_SEQUENCERS = new Set(["run-s", "run-p", "npm-run-all"]);
const COMMAND_PREFIXES = new Set(["npx", "bunx", "cross-env", "exec"]);
const TOOL_CONFIG_STEMS = {
  tsup: "tsup.config",
  tsdown: "tsdown.config",
  vite: "vite.config",
  rollup: "rollup.config",
  unbuild: "build.config",
  rslib: "rslib.config",
  webpack: "webpack.config",
};
const CONFIG_EXTENSIONS = ["ts", "mts", "cts", "js", "mjs", "cjs", "json"];
const POSITIONAL_ENTRY_TOOLS = new Set(["tsup", "tsdown", "esbuild"]);

function packageDirectoryOf(fileName) {
  let directory = posix.dirname(fileName);
  while (!existsSync(posix.join(directory, "package.json"))) {
    const parent = posix.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
  return directory;
}

function entryStrings(manifestField) {
  if (typeof manifestField === "string") return [manifestField];
  if (Array.isArray(manifestField)) return manifestField.flatMap(entryStrings);
  if (manifestField && typeof manifestField === "object") {
    return Object.values(manifestField).flatMap(entryStrings);
  }
  return [];
}

function packageEntries(manifest, directory) {
  return [
    ...new Set(
      [
        ...entryStrings(manifest.exports),
        ...ENTRY_FIELDS.flatMap((field) => entryStrings(manifest[field])),
      ]
        .filter((entry) => SCRIPT_ENTRY.test(entry))
        .map((entry) => posix.join(directory, entry))
    ),
  ];
}

function entryPattern(entry) {
  const escaped = entry.replace(/[.+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^${escaped.replaceAll("*", ".*")}$`, "u");
}

function commandWords(command) {
  const words = command
    .trim()
    .split(/\s+/u)
    .filter((word) => word && !/^[A-Z_][A-Z0-9_]*=/u.test(word));
  while (COMMAND_PREFIXES.has(words[0])) words.shift();
  return words;
}

function scriptPatternMatches(pattern, name) {
  return pattern.endsWith("*")
    ? name.startsWith(pattern.slice(0, -1))
    : name === pattern;
}

function buildCommands(scripts, name, seen) {
  if (seen.has(name) || typeof scripts[name] !== "string") return [];
  seen.add(name);
  return scripts[name].split(/&&|\|\||;/u).flatMap((command) => {
    const words = commandWords(command);
    if (SCRIPT_RUNNERS.has(words[0])) {
      const rest = words.slice(words[1] === "run" ? 2 : 1);
      while (COMMAND_PREFIXES.has(rest[0])) rest.shift();
      return rest[0] in scripts
        ? buildCommands(scripts, rest[0], seen)
        : [rest];
    }
    if (SCRIPT_SEQUENCERS.has(words[0])) {
      return words
        .slice(1)
        .filter((word) => !word.startsWith("-"))
        .flatMap((pattern) =>
          Object.keys(scripts)
            .filter((script) => scriptPatternMatches(pattern, script))
            .flatMap((script) => buildCommands(scripts, script, seen))
        );
    }
    return [words];
  });
}

function argumentAfterFlag(words, names) {
  const index = words.findIndex((word) => names.includes(word));
  const flagArgument = index >= 0 ? words[index + 1] : undefined;
  return flagArgument && !flagArgument.startsWith("-")
    ? flagArgument
    : undefined;
}

function toolConfigFile(directory, tool, words) {
  const explicit = argumentAfterFlag(words, ["--config", "-c"]);
  if (explicit) return posix.join(directory, explicit);
  return CONFIG_EXTENSIONS.map((extension) =>
    posix.join(directory, `${TOOL_CONFIG_STEMS[tool]}.${extension}`)
  ).find((candidate) => existsSync(candidate));
}

function positionalInputs(words) {
  return words
    .slice(1)
    .filter(
      (word, index, rest) =>
        !word.startsWith("-") &&
        !(index > 0 && rest[index - 1].startsWith("-")) &&
        SCRIPT_ENTRY.test(word)
    )
    .map((input) => ({ input }));
}

function commandBuild(directory, words) {
  const [tool] = words;
  if (tool === "tsc") {
    const projects = words
      .slice(1)
      .filter((word) => !word.startsWith("-") && word.endsWith(".json"));
    const project = argumentAfterFlag(words, ["-p", "--project"]);
    return {
      compilerConfigs: (project ? [project] : projects)
        .concat(project || projects.length ? [] : ["tsconfig.json"])
        .map((config) => posix.join(directory, config)),
      inputs: [],
    };
  }
  const bundler = tool === "bun" && words[1] === "build" ? "esbuild" : tool;
  const inputs = POSITIONAL_ENTRY_TOOLS.has(bundler)
    ? positionalInputs(bundler === tool ? words : words.slice(1))
    : [];
  const configFile = TOOL_CONFIG_STEMS[bundler]
    ? toolConfigFile(directory, bundler, words)
    : undefined;
  return {
    compilerConfigs: [],
    inputs: configFile
      ? inputs.concat(declaredBuildInputs(configFile))
      : inputs,
  };
}

function declaredBuild(manifest, directory) {
  const commands = buildCommands(manifest.scripts ?? {}, "build", new Set());
  const build = { compilerConfigs: [], inputs: [] };
  for (const words of commands) {
    const step = commandBuild(directory, words);
    build.compilerConfigs.push(...step.compilerConfigs);
    build.inputs.push(...step.inputs);
  }
  build.inputs.push(
    ...entryStrings(manifest.source).map((input) => ({ input }))
  );
  return build;
}

function outputStem(path) {
  return posix.basename(path).replace(OUTPUT_EXTENSION, "");
}

function entrySources(entry, sources, outputs, inputs, directory) {
  const pattern = entryPattern(entry);
  const direct = sources.filter(
    (sourceFile) =>
      pattern.test(sourceFile.fileName) ||
      pattern.test(sourceFile.fileName.replace(SOURCE_EXTENSION, ""))
  );
  if (direct.length > 0) return direct;
  const compiled = outputs
    .filter(({ name }) => pattern.test(name))
    .map(({ sourceFile }) => sourceFile);
  if (compiled.length > 0) return compiled;
  const stem = outputStem(entry);
  return inputs
    .filter(({ name, input }) => (name ?? outputStem(input)) === stem)
    .flatMap(({ input }) => {
      const inputStem = posix
        .join(directory, input)
        .replace(/\.[cm]?[jt]sx?$/u, "");
      return sources.filter(
        (sourceFile) =>
          sourceFile.fileName.replace(SOURCE_EXTENSION, "") === inputStem
      );
    });
}

function surfaceOf(program, directory) {
  const manifest = JSON.parse(
    readFileSync(posix.join(directory, "package.json"), "utf8")
  );
  const entries = packageEntries(manifest, directory);
  if (entries.length === 0) return { targets: new Set(), unresolved: [] };
  const build = declaredBuild(manifest, directory);
  const sources = packageSources(program, directory);
  const outputs = compilerOutputs(sources, build.compilerConfigs);
  const resolved = new Set();
  const unresolved = [];
  for (const entry of entries) {
    const matched = entrySources(
      entry,
      sources,
      outputs,
      build.inputs,
      directory
    );
    if (matched.length === 0) unresolved.push(entry);
    for (const sourceFile of matched) resolved.add(sourceFile);
  }
  return { targets: moduleExportTargets(program, resolved), unresolved };
}

export function publicSurfaceReason(program, nameNode) {
  const directory = packageDirectoryOf(nameNode.getSourceFile().fileName);
  if (!directory) return null;
  const surfaces = packageSurfaces.get(program) ?? new Map();
  packageSurfaces.set(program, surfaces);
  if (!surfaces.has(directory)) {
    surfaces.set(directory, surfaceOf(program, directory));
  }
  const surface = surfaces.get(directory);
  if (surface.targets.has(exportTarget(program, nameNode))) {
    return "exported from the package entry points";
  }
  return surface.unresolved.length > 0
    ? `public surface unresolved: entry ${surface.unresolved[0]} maps to no source through the package build`
    : null;
}
