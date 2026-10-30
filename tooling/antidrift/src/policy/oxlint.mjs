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

const LINTER_PLATFORM_KEYS = {
  "linux-x64": "linux-x64-gnu",
  "linux-arm64": "linux-arm64-gnu",
  "darwin-x64": "darwin-x64",
  "darwin-arm64": "darwin-arm64",
  "win32-x64": "win32-x64-msvc",
  "win32-arm64": "win32-arm64-msvc",
};

const OXLINT_VALUE_FLAGS = [
  "--config",
  "-c",
  "--format",
  "-f",
  "--threads",
  "--tsconfig",
  "--ignore-pattern",
];

const OXLINT_USAGE =
  [
    "Usage: antidrift oxlint [paths...] [-- oxlint-options...]",
    "",
    "Runs the unified Oxlint + native Rust antidrift-linter (tsrs) gate.",
  ].join("\n") + "\n";

const ADDON_LIBRARY_NAMES = {
  darwin: "libantidrift_napi.dylib",
  linux: "libantidrift_napi.so",
  win32: "antidrift_napi.dll",
};

const NATIVE_ARTIFACTS = {
  linter: {
    env: "ANTIDRIFT_LINTER_BIN",
    builds: [
      "target/debug/antidrift-linter",
      "target/release/antidrift-linter",
    ],
    staged: [
      "bin/antidrift-linter",
      "../bin/antidrift-linter",
      "dist/bin/antidrift-linter",
    ],
    packageFile: "antidrift-linter",
  },
  addon: {
    env: "ANTIDRIFT_NAPI_ADDON",
    builds: [
      `target/debug/${ADDON_LIBRARY_NAMES[process.platform]}`,
      `target/release/${ADDON_LIBRARY_NAMES[process.platform]}`,
    ],
    staged: ["dist/bin/antidrift.node"],
    packageFile: "antidrift.node",
  },
};

function localArtifactCandidates(artifact, cwd) {
  const localCandidates = [
    ...artifact.builds.flatMap((build) => [
      resolve(cwd, build),
      resolve(repoRoot, build),
    ]),
    ...artifact.staged.map((staged) => resolve(moduleRoot, staged)),
  ].filter((candidate) => existsSync(candidate));
  return localCandidates.sort(
    (left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs
  );
}

function platformArtifactPackages(artifact) {
  const platformKey =
    LINTER_PLATFORM_KEYS[`${process.platform}-${process.arch}`];
  if (!platformKey) return [];
  const require = createRequire(import.meta.url);
  try {
    return [
      require.resolve(
        `@joedeleeuw/antidrift-linter-${platformKey}/${artifact.packageFile}`
      ),
    ];
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "MODULE_NOT_FOUND"
    ) {
      throw error;
    }
    return [];
  }
}

function resolveNativeArtifact(artifact, cwd) {
  if (process.env[artifact.env]) {
    return process.env[artifact.env];
  }
  return [
    ...localArtifactCandidates(artifact, cwd),
    ...platformArtifactPackages(artifact),
  ].find((candidate) => existsSync(candidate));
}

export function resolveNativeLinterBinary(cwd = process.cwd()) {
  const found = resolveNativeArtifact(NATIVE_ARTIFACTS.linter, cwd);
  if (found && (statSync(found).mode & 0o111) === 0) {
    chmodSync(found, 0o755);
  }
  return found;
}

export function loadNativeAddon(cwd = process.cwd()) {
  const addonPath = resolveNativeArtifact(NATIVE_ARTIFACTS.addon, cwd);
  if (!addonPath) {
    throw new Error(
      `Missing the antidrift Oxlint addon for ${process.platform}-${process.arch}; build crates/antidrift-napi or install the matching @joedeleeuw/antidrift-linter platform package.`
    );
  }
  const addonModule = { exports: {} };
  process.dlopen(addonModule, addonPath);
  return addonModule.exports;
}

function defaultTargets() {
  return ["."];
}

export function parseOxlintArgs(argv) {
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
      if (OXLINT_VALUE_FLAGS.includes(arg) && next) {
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

function oxlintCommandArgs({ passthrough, targets }) {
  const typeAwareFlags = passthrough.includes("--type-aware")
    ? []
    : ["--type-aware"];
  return [
    resolveOxlintBinary(),
    "--disable-nested-config",
    ...typeAwareFlags,
    ...passthrough,
    ...targets,
  ];
}

export function runOxlint({
  argv = [],
  cwd = process.cwd(),
  spawn = spawnSync,
  stdout = defaultStdout,
  stderr = defaultStderr,
  exit = process.exit,
} = {}) {
  const parsed = parseOxlintArgs(argv);
  if (parsed.help) {
    stdout.write(OXLINT_USAGE);
    return exit(0);
  }
  const tsgolintBinary = resolveNativeLinterBinary(cwd);
  if (!tsgolintBinary) {
    stderr.write(
      "Missing antidrift-linter native binary; build crates/antidrift-linter or run pnpm --filter @joedeleeuw/antidrift build.\n"
    );
    return exit(1);
  }
  const args = oxlintCommandArgs(parsed);
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
