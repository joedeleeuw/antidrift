import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
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

export const LINTER_PLATFORMS = [
  {
    key: "linux-x64-gnu",
    os: "linux",
    cpu: "x64",
    libc: "glibc",
    target: "x86_64-unknown-linux-gnu",
  },
  {
    key: "linux-arm64-gnu",
    os: "linux",
    cpu: "arm64",
    libc: "glibc",
    target: "aarch64-unknown-linux-gnu",
  },
  {
    key: "linux-x64-musl",
    os: "linux",
    cpu: "x64",
    libc: "musl",
    target: "x86_64-unknown-linux-musl",
  },
  {
    key: "linux-arm64-musl",
    os: "linux",
    cpu: "arm64",
    libc: "musl",
    target: "aarch64-unknown-linux-musl",
  },
  {
    key: "darwin-arm64",
    os: "darwin",
    cpu: "arm64",
    target: "aarch64-apple-darwin",
  },
  {
    key: "win32-x64-msvc",
    os: "win32",
    cpu: "x64",
    target: "x86_64-pc-windows-msvc",
  },
  {
    key: "win32-arm64-msvc",
    os: "win32",
    cpu: "arm64",
    target: "aarch64-pc-windows-msvc",
  },
];

function linuxLibc() {
  process.report.excludeNetwork = true;
  return process.report.getReport().header.glibcVersionRuntime
    ? "glibc"
    : "musl";
}

export function hostLinterPlatform() {
  const libc = process.platform === "linux" ? linuxLibc() : undefined;
  const platform = LINTER_PLATFORMS.find(
    (row) =>
      row.os === process.platform &&
      row.cpu === process.arch &&
      row.libc === libc
  );
  if (!platform) {
    const host = [process.platform, process.arch, libc]
      .filter(Boolean)
      .join("-");
    throw new Error(
      `antidrift-linter ships no platform package for ${host}; supported platforms: ${LINTER_PLATFORMS.map(({ key }) => key).join(", ")}. Elsewhere, build crates/antidrift-linter and crates/antidrift-napi and point ANTIDRIFT_LINTER_BIN and ANTIDRIFT_NAPI_ADDON at the results.`
    );
  }
  return platform;
}

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

export const ADDON_LIBRARY_NAMES = {
  darwin: "libantidrift_napi.dylib",
  linux: "libantidrift_napi.so",
  win32: "antidrift_napi.dll",
};

export const ADDON_PACKAGE_PATH = "antidrift.node";

export const NATIVE_ARTIFACTS = {
  linter: {
    env: "ANTIDRIFT_LINTER_BIN",
    builds: [
      "target/debug/antidrift-linter",
      "target/release/antidrift-linter",
    ],
    packageSubpath: "",
  },
  addon: {
    env: "ANTIDRIFT_NAPI_ADDON",
    builds: [
      `target/debug/${ADDON_LIBRARY_NAMES[process.platform]}`,
      `target/release/${ADDON_LIBRARY_NAMES[process.platform]}`,
    ],
    packageSubpath: `/${ADDON_PACKAGE_PATH}`,
  },
};

function localArtifactCandidates(artifact, cwd) {
  const localCandidates = artifact.builds
    .flatMap((build) => [resolve(cwd, build), resolve(repoRoot, build)])
    .filter((candidate) => existsSync(candidate));
  return localCandidates.sort(
    (left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs
  );
}

function platformArtifactPackage(artifact) {
  const require = createRequire(import.meta.url);
  try {
    return require.resolve(
      `@joedeleeuw/antidrift-linter-${hostLinterPlatform().key}${artifact.packageSubpath}`
    );
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "MODULE_NOT_FOUND"
    ) {
      throw error;
    }
    return undefined;
  }
}

export function resolveNativeArtifact(artifact, cwd) {
  if (process.env[artifact.env]) {
    return process.env[artifact.env];
  }
  const [localBuild] = localArtifactCandidates(artifact, cwd);
  return localBuild ?? platformArtifactPackage(artifact);
}

export function loadNativeAddon(cwd = process.cwd()) {
  const addonPath = resolveNativeArtifact(NATIVE_ARTIFACTS.addon, cwd);
  if (!addonPath) {
    const { key } = hostLinterPlatform();
    throw new Error(
      `Missing the antidrift Oxlint addon for ${key}; build crates/antidrift-napi or install @joedeleeuw/antidrift-linter-${key}.`
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
  const tsgolintBinary = resolveNativeArtifact(NATIVE_ARTIFACTS.linter, cwd);
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
