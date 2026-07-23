import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const defaultStdout = { write: (value) => process.stdout.write(value) };
const defaultStderr = { write: (value) => process.stderr.write(value) };
const defaultExit = (status) => process.exit(status);

export function resolveOxlintBinary() {
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

export function parseOxlintArgs(
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
          "--config",
          "-c",
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

export function runOxlint({
  argv = [],
  cwd = process.cwd(),
  spawn = spawnSync,
  stdout = defaultStdout,
  stderr = defaultStderr,
  exit = defaultExit,
} = {}) {
  const parsed = parseOxlintArgs(argv, { cwd });
  if (parsed.help) {
    stdout.write(
      [
        "Usage: antidrift oxlint [paths...] [-- oxlint-options...]",
        "",
        "Runs the repository Oxlint gate, including native type-aware rules and Antidrift JS rules.",
      ].join("\n") + "\n",
    );
    return exit(0);
  }
  const args = [
    resolveOxlintBinary(),
    "--disable-nested-config",
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
