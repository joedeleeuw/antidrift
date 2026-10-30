import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ADDON_LIBRARY_NAMES,
  ADDON_PACKAGE_PATH,
  LINTER_PLATFORM_KEYS,
} from "../src/policy/oxlint.mjs";

const [platformKey, outputArgument] = process.argv.slice(2);
if (!platformKey || !outputArgument) {
  throw new Error(
    "Usage: node scripts/stage-platform-package.mjs <platform-key> <output-dir>"
  );
}

const hostPlatform = `${process.platform}-${process.arch}`;
const hostPlatformKey = LINTER_PLATFORM_KEYS[hostPlatform];
if (hostPlatformKey !== platformKey) {
  throw new Error(
    `Cannot stage platform ${platformKey} on host ${hostPlatform}; the host platform key is ${hostPlatformKey ?? "unsupported"}`
  );
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "../..");
const manifestPath = resolve(packageRoot, "npm", platformKey, "package.json");
const outputDirectory = resolve(outputArgument);
mkdirSync(outputDirectory, { recursive: true });
cpSync(manifestPath, resolve(outputDirectory, "package.json"));

const manifest = JSON.parse(String(readFileSync(manifestPath)));
if (typeof manifest.main !== "string" || manifest.main.length === 0) {
  throw new Error(`Missing main in ${manifestPath} for ${platformKey}`);
}
const metadata = JSON.parse(
  String(
    execFileSync("cargo", ["metadata", "--format-version", "1", "--no-deps"], {
      cwd: repoRoot,
      encoding: "utf8",
    })
  )
);
if (typeof metadata.target_directory !== "string") {
  throw new Error(
    `cargo metadata did not report a target_directory for ${platformKey}`
  );
}
const addonLibraryName = ADDON_LIBRARY_NAMES[process.platform];
if (!addonLibraryName) {
  throw new Error(`Missing addon library name for ${hostPlatform}`);
}
const nativeArtifacts = [
  { source: manifest.main, target: manifest.main },
  { source: addonLibraryName, target: ADDON_PACKAGE_PATH },
];
for (const artifact of nativeArtifacts) {
  const sourceArtifact = resolve(
    metadata.target_directory,
    "release",
    artifact.source
  );
  if (!existsSync(sourceArtifact)) {
    throw new Error(
      `Missing native artifact for ${platformKey} at ${sourceArtifact}`
    );
  }
  const targetArtifact = resolve(outputDirectory, artifact.target);
  cpSync(sourceArtifact, targetArtifact);
  chmodSync(targetArtifact, 0o755);
}
