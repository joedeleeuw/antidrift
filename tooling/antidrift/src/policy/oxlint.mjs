import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultStdout = { write: (value) => process.stdout.write(value) };
const defaultStderr = { write: (value) => process.stderr.write(value) };
const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const repoRoot = resolve(moduleRoot, "../..");

export function resolveOxlintBinary() {
  const require = createRequire(import.meta.url);
  const packageJsonPath = require.resolve("oxlint/package.json");
  const packageJson = require(packageJsonPath);
  return resolve(dirname(packageJsonPath), packageJson.bin.oxlint);
}

export function resolveNativeLinterBinary(cwd = process.cwd()) {
  if (process.env.ANTIDRIFT_LINTER_BIN) {
    return process.env.ANTIDRIFT_LINTER_BIN;
  }
  const localCandidates = [
    resolve(cwd, "target/debug/antidrift-linter"),
    resolve(repoRoot, "target/debug/antidrift-linter"),
    resolve(cwd, "target/release/antidrift-linter"),
    resolve(repoRoot, "target/release/antidrift-linter"),
    resolve(moduleRoot, "bin/antidrift-linter"),
    resolve(moduleRoot, "../bin/antidrift-linter"),
    resolve(moduleRoot, "dist/bin/antidrift-linter"),
  ].filter((candidate) => existsSync(candidate));
  localCandidates.sort(
    (left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs
  );
  const candidates = [...localCandidates];
  const platformKey = {
    "linux-x64": "linux-x64-gnu",
    "linux-arm64": "linux-arm64-gnu",
    "darwin-x64": "darwin-x64",
    "darwin-arm64": "darwin-arm64",
    "win32-x64": "win32-x64-msvc",
    "win32-arm64": "win32-arm64-msvc",
  }[`${process.platform}-${process.arch}`];
  if (platformKey) {
    const require = createRequire(import.meta.url);
    try {
      candidates.push(
        require.resolve(`@joedeleeuw/antidrift-linter-${platformKey}`)
      );
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "MODULE_NOT_FOUND"
      ) {
        throw error;
      }
    }
  }
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found && (statSync(found).mode & 0o111) === 0) {
    chmodSync(found, 0o755);
  }
  return found;
}

function defaultTargets() {
  return ["."];
}

export function parseOxlintArgs(argv, _options = {}) {
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
    targets: targets.length > 0 ? targets : defaultTargets(),
  };
}

export function runOxlint({
  argv = [],
  cwd = process.cwd(),
  spawn = spawnSync,
  stdout = defaultStdout,
  stderr = defaultStderr,
  exit = process.exit,
} = {}) {
  const parsed = parseOxlintArgs(argv, { cwd });
  if (parsed.help) {
    stdout.write(
      [
        "Usage: antidrift oxlint [paths...] [-- oxlint-options...]",
        "",
        "Runs the unified Oxlint + native Rust antidrift-linter (tsrs) gate.",
      ].join("\n") + "\n"
    );
    return exit(0);
  }
  const tsgolintBinary = resolveNativeLinterBinary(cwd);
  if (!tsgolintBinary) {
    stderr.write(
      "Missing antidrift-linter native binary; build crates/antidrift-linter or run pnpm --filter @joedeleeuw/antidrift build.\n"
    );
    return exit(1);
  }
  const typeAwareFlags = parsed.passthrough.includes("--type-aware")
    ? []
    : ["--type-aware"];
  const args = [
    resolveOxlintBinary(),
    "--disable-nested-config",
    ...typeAwareFlags,
    ...parsed.passthrough,
    ...parsed.targets,
  ];
  const env = {
    ...process.env,
    OXLINT_TSGOLINT_PATH: tsgolintBinary,
    ANTIDRIFT_TSGOLINT_DEFAULTS: "1",
  };
  const result = spawn(process.execPath, args, { cwd, env, stdio: "inherit" });
  if (result.error) {
    stderr.write(`Failed to run oxlint: ${result.error.message}\n`);
    return exit(1);
  }
  return exit(result.status ?? 1);
}
