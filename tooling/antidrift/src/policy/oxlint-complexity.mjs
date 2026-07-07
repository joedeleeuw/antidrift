import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const oxlintComplexityConfig = fileURLToPath(
  new URL("./oxlint-complexity.config.json", import.meta.url),
);

export const oxlintComplexityIgnorePatterns = [
  "**/node_modules/**",
  "**/dist/**",
  "**/coverage/**",
  "reports/**",
  "**/fixtures/**",
  "**/*.test.*",
  "**/*.spec.*",
  "**/*.d.ts",
  "**/*.d.mts",
  "**/*.d.cts",
];

const defaultStdout = { write: (value) => process.stdout.write(value) };
const defaultStderr = { write: (value) => process.stderr.write(value) };
const defaultExit = (status) => process.exit(status);

function oxlintBinary() {
  const require = createRequire(import.meta.url);
  const packageJsonPath = require.resolve("oxlint/package.json");
  const packageJson = require(packageJsonPath);
  return resolve(dirname(packageJsonPath), packageJson.bin.oxlint);
}

function defaultTargets(cwd, exists = existsSync) {
  const candidates = ["apps", "packages", "tooling", "src"].filter((target) =>
    exists(resolve(cwd, target)),
  );
  return candidates.length > 0 ? candidates : ["."];
}

export function parseOxlintComplexityArgs(
  argv,
  { cwd = process.cwd(), exists = existsSync } = {},
) {
  const targets = [];
  const passthrough = [];
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--") {
      passthrough.push(...argv.slice(index + 1));
      break;
    }
    if (arg.startsWith("-")) {
      passthrough.push(arg);
      const next = argv[index + 1];
      if (
        [
          "--format",
          "-f",
          "--threads",
          "--tsconfig",
          "--ignore-pattern",
        ].includes(arg) &&
        next
      ) {
        passthrough.push(next);
        index += 1;
      }
      continue;
    }
    targets.push(arg);
  }
  return {
    help,
    passthrough,
    targets: targets.length > 0 ? targets : defaultTargets(cwd, exists),
  };
}

export function runOxlintComplexity({
  argv = [],
  cwd = process.cwd(),
  spawn = spawnSync,
  stdout = defaultStdout,
  stderr = defaultStderr,
  exit = defaultExit,
} = {}) {
  const parsed = parseOxlintComplexityArgs(argv, { cwd });
  if (parsed.help) {
    stdout.write(
      [
        "Usage: antidrift oxlint [paths...] [-- oxlint-options...]",
        "",
        "Runs the bundled oxlint complexity gate with Antidrift thresholds.",
      ].join("\n") + "\n",
    );
    return exit(0);
  }
  const args = [
    oxlintBinary(),
    "--config",
    oxlintComplexityConfig,
    "--disable-nested-config",
    ...oxlintComplexityIgnorePatterns.flatMap((pattern) => [
      "--ignore-pattern",
      pattern,
    ]),
    ...parsed.passthrough,
    ...parsed.targets,
  ];
  const result = spawn(process.execPath, args, { cwd, stdio: "inherit" });
  if (result.error) {
    stderr.write(`Failed to run oxlint: ${result.error.message}\n`);
    return exit(1);
  }
  return exit(result.status ?? 1);
}
