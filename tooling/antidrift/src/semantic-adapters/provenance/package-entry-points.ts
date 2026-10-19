import { existsSync, readFileSync, statSync } from "node:fs";
import { posix } from "node:path";
import type ts from "typescript";
import { z } from "zod";
import {
  compilerOutputs,
  exportTarget,
  moduleExportTargets,
  packageSources,
} from "./package-program.ts";
import {
  BUILD_TOOLS,
  isBuildTool,
  declaredBuildInputs,
} from "./build-configuration.ts";
import type { BuildTool, BuildInput } from "./build-configuration.ts";

const packageManifestDecoder = z.object({
  exports: z.unknown(),
  main: z.unknown(),
  module: z.unknown(),
  types: z.unknown(),
  typings: z.unknown(),
  browser: z.unknown(),
  bin: z.unknown(),
  source: z.unknown(),
  scripts: z.record(z.unknown()).optional(),
});
type PackageManifest = z.infer<typeof packageManifestDecoder>;
type Surface =
  | ReturnType<typeof surfaceOf>
  | {
      readonly failed: string;
    };
const packageSurfaces = new WeakMap<ts.Program, Map<string, Surface>>();
const ENTRY_FIELDS = [
  "main",
  "module",
  "types",
  "typings",
  "browser",
  "bin",
] as const;
const SCRIPT_ENTRY = /(?:\.[cm]?[jt]sx?|\/[^./]*)$/u;
const SOURCE_EXTENSION = /\.[cm]?tsx?$/u;
const OUTPUT_EXTENSION = /(?:\.d)?\.[cm]?[jt]sx?$/u;
const SCRIPT_RUNNERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const SCRIPT_SEQUENCERS = new Set(["run-s", "run-p", "npm-run-all"]);
const COMMAND_PREFIXES = new Set(["npx", "bunx", "cross-env", "exec"]);
const CONFIG_EXTENSIONS = ["ts", "mts", "cts", "js", "mjs", "cjs", "json"];
const POSITIONAL_ENTRY_TOOLS = new Set(["tsup", "tsdown", "esbuild"]);
function isManifestFile(path: string) {
  return existsSync(path) && statSync(path).isFile();
}
function packageDirectoryOf(fileName: string) {
  let directory = posix.dirname(fileName);
  while (!isManifestFile(posix.join(directory, "package.json"))) {
    const parent = posix.dirname(directory);
    if (parent === directory) {
      return null;
    }
    directory = parent;
  }
  return directory;
}
function entryStrings(manifestField: unknown): string[] {
  if (typeof manifestField === "string") {
    return [manifestField];
  }
  if (Array.isArray(manifestField)) {
    const entries: readonly unknown[] = manifestField;
    return entries.flatMap(entryStrings);
  }
  if (manifestField && typeof manifestField === "object") {
    return Object.values(manifestField).flatMap(entryStrings);
  }
  return [];
}
function packageEntries(manifest: PackageManifest, directory: string) {
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
function entryPattern(entry: string) {
  const escaped = entry.replace(/[.+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^${escaped.replaceAll("*", ".*")}$`, "u");
}
function commandWords(command: string) {
  const words = command
    .trim()
    .split(/\s+/u)
    .filter((word) => word && !/^[A-Z_][A-Z0-9_]*=/u.test(word));
  while (COMMAND_PREFIXES.has(words[0] ?? "")) {
    words.shift();
  }
  return words;
}
function scriptPatternMatches(pattern: string, name: string) {
  return pattern.endsWith("*")
    ? name.startsWith(pattern.slice(0, -1))
    : name === pattern;
}
function buildCommands(
  scripts: Readonly<Record<string, unknown>>,
  name: string,
  seen: Set<string>
): string[][] {
  const script = scripts[name];
  if (seen.has(name) || typeof script !== "string") {
    return [];
  }
  seen.add(name);
  return script.split(/&&|\|\||;/u).flatMap((command) => {
    const words = commandWords(command);
    if (SCRIPT_RUNNERS.has(words[0] ?? "")) {
      const rest = words.slice(words[1] === "run" ? 2 : 1);
      while (COMMAND_PREFIXES.has(rest[0] ?? "")) {
        rest.shift();
      }
      return rest[0] !== undefined && rest[0] in scripts
        ? buildCommands(scripts, rest[0], seen)
        : [rest];
    }
    if (SCRIPT_SEQUENCERS.has(words[0] ?? "")) {
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
function argumentAfterFlag(words: readonly string[], names: readonly string[]) {
  const index = words.findIndex((word) => names.includes(word));
  const flagArgument = index >= 0 ? words[index + 1] : undefined;
  return flagArgument && !flagArgument.startsWith("-")
    ? flagArgument
    : undefined;
}
function toolConfigFile(
  directory: string,
  tool: BuildTool,
  words: readonly string[]
) {
  const explicit = argumentAfterFlag(words, ["--config", "-c"]);
  if (explicit) {
    return posix.join(directory, explicit);
  }
  return CONFIG_EXTENSIONS.map((extension) =>
    posix.join(directory, `${BUILD_TOOLS[tool].configStem}.${extension}`)
  ).find((candidate) => existsSync(candidate));
}
function positionalInputs(words: readonly string[]) {
  return words
    .slice(1)
    .filter(
      (word, index, rest) =>
        !word.startsWith("-") &&
        !(index > 0 && rest[index - 1]?.startsWith("-")) &&
        SCRIPT_ENTRY.test(word)
    )
    .map((input) => ({ input }));
}
function commandBuild(directory: string, words: readonly string[]) {
  const tool = words[0] ?? "";
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
      issues: [],
    };
  }
  const bundler = tool === "bun" && words[1] === "build" ? "esbuild" : tool;
  const inputs = POSITIONAL_ENTRY_TOOLS.has(bundler)
    ? positionalInputs(bundler === tool ? words : words.slice(1))
    : [];
  let declared: ReturnType<typeof declaredBuildInputs> = { inputs: [] };
  if (isBuildTool(bundler)) {
    const configFile = toolConfigFile(directory, bundler, words);
    if (configFile) {
      declared = declaredBuildInputs(configFile, bundler);
    }
  }
  return {
    compilerConfigs: [],
    inputs: inputs.concat(declared.inputs ?? []),
    issues: declared.unresolved ? [declared.unresolved] : [],
  };
}
function declaredBuild(manifest: PackageManifest, directory: string) {
  const commands = buildCommands(manifest.scripts ?? {}, "build", new Set());
  const compilerConfigs: string[] = [];
  const inputs: BuildInput[] = [];
  const issues: string[] = [];
  const build = { compilerConfigs, inputs, issues };
  for (const words of commands) {
    const step = commandBuild(directory, words);
    build.compilerConfigs.push(...step.compilerConfigs);
    build.inputs.push(...step.inputs);
    build.issues.push(...step.issues);
  }
  build.inputs.push(
    ...entryStrings(manifest.source).map((input) => ({ input }))
  );
  return build;
}
function outputStem(path: string) {
  return posix.basename(path).replace(OUTPUT_EXTENSION, "");
}
function entrySources(
  entry: string,
  sources: readonly ts.SourceFile[],
  outputs: ReturnType<typeof compilerOutputs>,
  inputs: readonly BuildInput[],
  directory: string
) {
  const pattern = entryPattern(entry);
  const direct = sources.filter(
    (sourceFile) =>
      pattern.test(sourceFile.fileName) ||
      pattern.test(sourceFile.fileName.replace(SOURCE_EXTENSION, ""))
  );
  if (direct.length > 0) {
    return direct;
  }
  const compiled = outputs
    .filter(({ name }) => pattern.test(name))
    .map(({ sourceFile }) => sourceFile);
  if (compiled.length > 0) {
    return compiled;
  }
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
function surfaceOf(program: ts.Program, directory: string) {
  const manifest = packageManifestDecoder.parse(
    JSON.parse(readFileSync(posix.join(directory, "package.json"), "utf8"))
  );
  const entries = packageEntries(manifest, directory);
  if (entries.length === 0) {
    return { targets: new Set<ts.Symbol>(), unresolved: [], issues: [] };
  }
  const build = declaredBuild(manifest, directory);
  const sources = packageSources(program, directory);
  const outputs = compilerOutputs(sources, build.compilerConfigs);
  const resolved = new Set<ts.SourceFile>();
  const unresolved: string[] = [];
  for (const entry of entries) {
    const matched = entrySources(
      entry,
      sources,
      outputs,
      build.inputs,
      directory
    );
    if (matched.length === 0) {
      unresolved.push(entry);
    }
    for (const sourceFile of matched) {
      resolved.add(sourceFile);
    }
  }
  return {
    targets: moduleExportTargets(program, resolved),
    unresolved,
    issues: build.issues,
  };
}
export function publicSurface(program: ts.Program, nameNode: ts.Node) {
  const directory = packageDirectoryOf(nameNode.getSourceFile().fileName);
  if (!directory) {
    return {};
  }
  const surfaces = packageSurfaces.get(program) ?? new Map<string, Surface>();
  packageSurfaces.set(program, surfaces);
  if (!surfaces.has(directory)) {
    let surface: Surface;
    try {
      surface = surfaceOf(program, directory);
    } catch (error) {
      surface = {
        failed: `${posix.join(directory, "package.json")} could not be read as a package build: ${error}`,
      };
    }
    surfaces.set(directory, surface);
  }
  const surface = surfaces.get(directory);
  if (!surface) {
    throw new TypeError(`No cached package surface for ${directory}`);
  }
  if ("failed" in surface) {
    return { incomplete: surface.failed };
  }
  if (surface.targets.has(exportTarget(program, nameNode))) {
    return { owner: "exported from the package entry points" };
  }
  if (surface.unresolved.length === 0) {
    return {};
  }
  const cause =
    surface.issues[0] ?? "the package build declares no input for it";
  return {
    incomplete: `package entry ${posix.relative(directory, surface.unresolved[0] ?? "")} maps to no source file: ${cause}`,
  };
}
