import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ADDON_LIBRARY_NAMES,
  ADDON_PACKAGE_PATH,
  LINTER_PLATFORMS,
  hostLinterPlatform,
} from "../src/policy/oxlint.mjs";

const [platformKey, outputArgument] = process.argv.slice(2);
if (!platformKey || !outputArgument) {
  throw new Error(
    "Usage: node scripts/stage-platform-package.mjs <platform-key> <output-dir>"
  );
}
const platform = LINTER_PLATFORMS.find(({ key }) => key === platformKey);
if (!platform) {
  throw new Error(
    `Unknown platform ${platformKey}; LINTER_PLATFORMS in src/policy/oxlint.mjs lists ${LINTER_PLATFORMS.map(({ key }) => key).join(", ")}`
  );
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "../..");
const parentManifest = JSON.parse(
  String(readFileSync(resolve(packageRoot, "package.json")))
);
const manifestPath = resolve(packageRoot, "npm", platformKey, "package.json");
const manifest = JSON.parse(String(readFileSync(manifestPath)));
const expectedFields = {
  name: `@joedeleeuw/antidrift-linter-${platform.key}`,
  version: parentManifest.version,
  engines: parentManifest.engines,
  os: [platform.os],
  cpu: [platform.cpu],
  libc: platform.libc && [platform.libc],
};
for (const [field, expected] of Object.entries(expectedFields)) {
  if (!isDeepStrictEqual(manifest[field], expected)) {
    throw new Error(
      `${manifestPath} field ${field} is ${JSON.stringify(manifest[field])}; the ${platform.key} row of LINTER_PLATFORMS and ${resolve(packageRoot, "package.json")} require ${JSON.stringify(expected)}`
    );
  }
}
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
const buildTarget = process.env.CARGO_BUILD_TARGET;
if (buildTarget && buildTarget !== platform.target) {
  throw new Error(
    `CARGO_BUILD_TARGET is ${buildTarget}, but ${platformKey} builds ${platform.target}`
  );
}
if (!buildTarget && hostLinterPlatform().key !== platformKey) {
  throw new Error(
    `Cannot stage ${platformKey} from a host build on ${hostLinterPlatform().key}; build with CARGO_BUILD_TARGET=${platform.target}`
  );
}
const releaseDirectory = buildTarget
  ? resolve(metadata.target_directory, buildTarget, "release")
  : resolve(metadata.target_directory, "release");

const outputDirectory = resolve(outputArgument);
mkdirSync(outputDirectory, { recursive: true });
cpSync(manifestPath, resolve(outputDirectory, "package.json"));
const nativeArtifacts = [
  { source: manifest.main, target: manifest.main },
  { source: ADDON_LIBRARY_NAMES[platform.os], target: ADDON_PACKAGE_PATH },
];
for (const artifact of nativeArtifacts) {
  const sourceArtifact = resolve(releaseDirectory, artifact.source);
  if (!existsSync(sourceArtifact)) {
    throw new Error(
      `Missing native artifact for ${platformKey} at ${sourceArtifact}`
    );
  }
  const targetArtifact = resolve(outputDirectory, artifact.target);
  cpSync(sourceArtifact, targetArtifact);
  chmodSync(targetArtifact, 0o755);
}
