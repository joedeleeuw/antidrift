import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { LINTER_PLATFORMS } from "../src/policy/oxlint.mjs";

const [packsArgument, archivesArgument] = process.argv.slice(2);
if (!packsArgument || !archivesArgument) {
  throw new Error(
    "Usage: node scripts/verify-release-set.mjs <platform-packs-dir> <release-archives-dir>"
  );
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const parentPath = resolve(packageRoot, "package.json");
const parent = JSON.parse(String(readFileSync(parentPath)));
const platformNames = LINTER_PLATFORMS.map(
  ({ key }) => `@joedeleeuw/antidrift-linter-${key}`
).sort();

function requireSame(actual, expected, subject) {
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(
      `${subject} is ${JSON.stringify(actual)}; LINTER_PLATFORMS in src/policy/oxlint.mjs requires ${JSON.stringify(expected)}`
    );
  }
}

requireSame(
  parent.optionalDependencies,
  Object.fromEntries(platformNames.map((name) => [name, parent.version])),
  `${parentPath} optionalDependencies`
);
requireSame(
  readdirSync(resolve(packageRoot, "npm")).sort(),
  LINTER_PLATFORMS.map(({ key }) => key).sort(),
  `${resolve(packageRoot, "npm")} directories`
);

const packsDirectory = resolve(packsArgument);
const packedSpecs = readdirSync(packsDirectory)
  .map((filename) => {
    const manifest = JSON.parse(
      String(
        execFileSync("tar", [
          "-xOzf",
          join(packsDirectory, filename),
          "package/package.json",
        ])
      )
    );
    return `${manifest.name}@${manifest.version}`;
  })
  .sort();
requireSame(
  packedSpecs,
  platformNames.map((name) => `${name}@${parent.version}`),
  `${packsDirectory} platform packages`
);

const archivesDirectory = resolve(archivesArgument);
requireSame(
  readdirSync(archivesDirectory).sort(),
  LINTER_PLATFORMS.map(
    ({ os, target }) =>
      `antidrift-linter-${target}${os === "win32" ? ".zip" : ".tar.gz"}`
  ).sort(),
  `${archivesDirectory} release archives`
);

console.log(
  `release set matches LINTER_PLATFORMS: ${packedSpecs.length} platform packages and ${LINTER_PLATFORMS.length} release archives at ${parent.version}`
);
