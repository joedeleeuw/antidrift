import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
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
  if (!process.report) {
    throw new Error(
      `antidrift-linter cannot tell glibc from musl on this Linux host: process.report is unavailable, so the libc marker cannot be read; supported platforms: ${LINTER_PLATFORMS.map(({ key }) => key).join(", ")}. Build crates/antidrift-linter and crates/antidrift-napi and point ANTIDRIFT_LINTER_BIN and ANTIDRIFT_NAPI_ADDON at the results.`
    );
  }
  process.report.excludeNetwork = true;
  const report = process.report.getReport();
  if (report.header.glibcVersionRuntime || report.header.glibcVersionCompiler) {
    return "glibc";
  }
  const loaders = report.sharedObjects.filter((entry) =>
    /\/ld-musl-|\/libc\.musl-/u.test(entry)
  );
  if (loaders.length > 0) {
    return "musl";
  }
  throw new Error(
    `antidrift-linter cannot tell glibc from musl on this Linux host: the process report carries no glibc marker and no musl loader among ${report.sharedObjects.length} shared objects; supported platforms: ${LINTER_PLATFORMS.map(({ key }) => key).join(", ")}. Build crates/antidrift-linter and crates/antidrift-napi and point ANTIDRIFT_LINTER_BIN and ANTIDRIFT_NAPI_ADDON at the results.`
  );
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

const ADDON_LIBRARY_NAME =
  process.platform in ADDON_LIBRARY_NAMES
    ? ADDON_LIBRARY_NAMES[process.platform]
    : undefined;

const LINTER_BINARY_NAME =
  process.platform === "win32" ? "antidrift-linter.exe" : "antidrift-linter";

export const ADDON_PACKAGE_PATH = "antidrift.node";

export const NATIVE_ARTIFACTS = {
  linter: {
    env: "ANTIDRIFT_LINTER_BIN",
    builds: [
      `target/release/${LINTER_BINARY_NAME}`,
      `target/debug/${LINTER_BINARY_NAME}`,
    ],
    packageSubpath: "",
  },
  addon: {
    env: "ANTIDRIFT_NAPI_ADDON",
    builds: ADDON_LIBRARY_NAME
      ? [
          `target/release/${ADDON_LIBRARY_NAME}`,
          `target/debug/${ADDON_LIBRARY_NAME}`,
        ]
      : [],
    packageSubpath: `/${ADDON_PACKAGE_PATH}`,
  },
};

function localArtifactCandidates(artifact, cwd) {
  return artifact.builds
    .flatMap((build) => [resolve(cwd, build), resolve(repoRoot, build)])
    .filter((candidate) => existsSync(candidate));
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
    return resolve(cwd, process.env[artifact.env]);
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

const PLUGIN_SPECIFIER_SUFFIX = "/oxlint-plugin/index.mjs";

function pluginSpecifier(entry) {
  return typeof entry === "string" ? entry : entry?.specifier;
}

function registersAntidriftPlugin(resolvedConfig) {
  return (resolvedConfig.jsPlugins ?? []).some((entry) =>
    String(pluginSpecifier(entry) ?? "")
      .replaceAll("\\", "/")
      .endsWith(PLUGIN_SPECIFIER_SUFFIX)
  );
}

const CONFIG_PREFLIGHT_FLAGS = new Set(["-c", "--config", "--tsconfig"]);

function configPreflightArgs(passthrough) {
  const args = [];
  for (let index = 0; index < passthrough.length; index += 1) {
    const arg = passthrough[index];
    if (CONFIG_PREFLIGHT_FLAGS.has(arg)) {
      args.push(arg);
      if (index + 1 < passthrough.length) {
        args.push(passthrough[index + 1]);
        index += 1;
      }
      continue;
    }
    if (
      arg.startsWith("--config=") ||
      arg.startsWith("-c=") ||
      arg.startsWith("--tsconfig=")
    ) {
      args.push(arg);
    }
  }
  return args;
}

function resolvedConfigRegistersPlugin({ passthrough, cwd, spawn }) {
  const printed = spawn(
    process.execPath,
    [
      resolveOxlintBinary(),
      "--print-config",
      ...configPreflightArgs(passthrough),
    ],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
  if (printed.error) throw printed.error;
  if (printed.status !== 0) {
    throw new Error(
      `oxlint --print-config failed (exit ${printed.status}): ${printed.stderr}`
    );
  }
  return registersAntidriftPlugin(JSON.parse(String(printed.stdout)));
}

function oxlintLaunch({ parsed, cwd, spawn }) {
  const tsgolintBinary = resolveNativeArtifact(NATIVE_ARTIFACTS.linter, cwd);
  if (!tsgolintBinary) {
    return {
      failure:
        "Missing antidrift-linter native binary; build crates/antidrift-linter or run pnpm --filter @joedeleeuw/antidrift build.\n",
    };
  }
  const addonBinary = resolveNativeArtifact(NATIVE_ARTIFACTS.addon, cwd);
  if (addonBinary && dirname(tsgolintBinary) !== dirname(addonBinary)) {
    return {
      failure: `antidrift native artifacts come from different directories (linter=${tsgolintBinary}, addon=${addonBinary}); build both with the same cargo profile or set ANTIDRIFT_LINTER_BIN and ANTIDRIFT_NAPI_ADDON to matching artifacts.\n`,
    };
  }
  const registered = resolvedConfigRegistersPlugin({
    passthrough: parsed.passthrough,
    cwd,
    spawn,
  });
  if (!registered) {
    return {
      failure:
        "The resolved Oxlint config does not register the antidrift plugin, so no antidrift rule would run. Spread createGovernanceOxlintConfig() from @joedeleeuw/antidrift/oxlint-config into your config (it sets jsPlugins and the antidrift/* rules), or pass -c with a config that does.\n",
    };
  }
  return {
    args: oxlintCommandArgs(parsed),
    env: {
      ...process.env,
      OXLINT_TSGOLINT_PATH: tsgolintBinary,
    },
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
  const parsed = parseOxlintArgs(argv);
  if (parsed.help) {
    stdout.write(OXLINT_USAGE);
    return exit(0);
  }
  const launch = oxlintLaunch({ parsed, cwd, spawn });
  if ("failure" in launch) {
    stderr.write(launch.failure);
    return exit(1);
  }
  const result = spawn(process.execPath, launch.args, {
    cwd,
    env: launch.env,
    stdio: "inherit",
  });
  if (result.error) {
    stderr.write(`Failed to run oxlint: ${result.error.message}\n`);
    return exit(1);
  }
  return exit(result.status ?? 1);
}
