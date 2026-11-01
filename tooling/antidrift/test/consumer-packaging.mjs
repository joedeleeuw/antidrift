import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import {
  ADDON_PACKAGE_PATH,
  hostLinterPlatform,
} from "../src/policy/oxlint.mjs";
import { run, fail, pkgDir, work, pnpmLaunch } from "./consumer-process.mjs";

function verifyParentTarball(tarball) {
  const packedFiles = new Set(
    run("tar", ["-tzf", tarball], work).trim().split(/\r?\n/u)
  );
  for (const required of [
    "package/NOTICE",
    "package/licenses/Apache-2.0.txt",
    "package/licenses/Rika-Labs-MIT.txt",
  ]) {
    if (!packedFiles.has(required)) {
      fail(`tarball missing required artifact: ${required}`);
    }
  }
  const forbiddenPrefixes = [
    "package/dist/bin/",
    "package/bin/",
    "package/dist/eslint-plugin/",
    "package/dist/semantic-adapters/",
    "package/dist/eslint-config/",
    "package/dist/oxlint-config/eslint-builtins.mjs",
    "package/dist/policy/lib/property-default-fallbacks.mjs",
    "package/test/",
  ];
  const shippedForbidden = [...packedFiles].filter((entry) =>
    forbiddenPrefixes.some((prefix) => entry.startsWith(prefix))
  );
  if (shippedForbidden.length > 0) {
    fail(`tarball contains forbidden entries: ${shippedForbidden.join(", ")}`);
  }
}

export function packParentTarball() {
  const packedParent = process.env.ANTIDRIFT_TARBALL;
  if (packedParent) {
    console.log(`1/6  using packed @joedeleeuw/antidrift ${packedParent} ...`);
    copyFileSync(resolve(packedParent), join(work, basename(packedParent)));
  } else {
    console.log("1/6  packing @joedeleeuw/antidrift ...");
    run(
      pnpmLaunch.file,
      [...pnpmLaunch.prefix, "pack", "--pack-destination", work],
      pkgDir
    );
  }
  const tgz = readdirSync(work).find((filename) => filename.endsWith(".tgz"));
  if (!tgz) fail("pack produced no tarball");
  const tarball = join(work, tgz);
  verifyParentTarball(tarball);
  return tarball;
}

function stagePlatformTarball(platformPack, platformKey) {
  const platformPackageDirectory = join(work, "platform-package");
  run(
    process.execPath,
    [
      join(pkgDir, "scripts/stage-platform-package.mjs"),
      platformKey,
      platformPackageDirectory,
    ],
    pkgDir
  );
  const npmCli = join(
    dirname(process.execPath),
    process.platform === "win32"
      ? "node_modules/npm/bin/npm-cli.js"
      : "../lib/node_modules/npm/bin/npm-cli.js"
  );
  if (!existsSync(npmCli)) {
    fail(`npm CLI not found beside Node at ${npmCli}`);
  }
  run(
    process.execPath,
    [
      npmCli,
      "pack",
      platformPackageDirectory,
      "--pack-destination",
      platformPack,
    ],
    work
  );
}

function verifyPlatformTarball(platformTarball, platformKey) {
  const platformManifest = JSON.parse(
    run("tar", ["-xOzf", platformTarball, "package/package.json"], work)
  );
  const platformPackageName = platformManifest.name;
  if (platformPackageName !== `@joedeleeuw/antidrift-linter-${platformKey}`) {
    fail(
      `${platformTarball} holds ${platformPackageName}, but this host resolves @joedeleeuw/antidrift-linter-${platformKey}`
    );
  }
  console.log(`  host platform: ${platformKey}`);
  const platformTarballContents = run(
    "tar",
    ["-tzf", platformTarball],
    work
  ).trim();
  console.log(`  platform tarball contents:\n${platformTarballContents}`);
  const platformPackedFiles = new Set(platformTarballContents.split(/\r?\n/u));
  for (const required of [
    `package/${ADDON_PACKAGE_PATH}`,
    `package/${platformManifest.main}`,
  ]) {
    if (!platformPackedFiles.has(required)) {
      fail(`platform tarball missing required artifact: ${required}`);
    }
  }
  return platformManifest;
}

export function packPlatformTarball() {
  const platformKey = hostLinterPlatform().key;
  const platformPack = join(work, "platform-pack");
  mkdirSync(platformPack);
  const packedPlatform = process.env.ANTIDRIFT_PLATFORM_TARBALL;
  if (packedPlatform) {
    copyFileSync(
      resolve(packedPlatform),
      join(platformPack, basename(packedPlatform))
    );
  } else {
    stagePlatformTarball(platformPack, platformKey);
  }
  const platformTarballs = readdirSync(platformPack).filter((name) =>
    name.endsWith(".tgz")
  );
  if (platformTarballs.length !== 1) {
    fail("platform pack must produce exactly one tarball");
  }
  const platformTarball = join(platformPack, platformTarballs[0]);
  const platformManifest = verifyPlatformTarball(platformTarball, platformKey);
  return { platformKey, platformTarball, platformManifest };
}

export function packToolingTarball() {
  let toolingTarball = process.env.TYPESCRIPT_TOOLING_TARBALL;
  if (toolingTarball) {
    toolingTarball = resolve(toolingTarball);
    run("tar", ["-tzf", toolingTarball], work);
  } else {
    const toolingRoot = dirname(
      createRequire(import.meta.url).resolve(
        "@joedeleeuw/typescript-tooling/package.json"
      )
    );
    const toolingPack = join(work, "tooling-pack");
    mkdirSync(toolingPack);
    run(
      pnpmLaunch.file,
      [...pnpmLaunch.prefix, "pack", "--pack-destination", toolingPack],
      toolingRoot
    );
    const packed = readdirSync(toolingPack).filter((name) =>
      name.endsWith(".tgz")
    );
    if (packed.length !== 1) {
      fail("tooling pack must produce exactly one tarball");
    }
    toolingTarball = join(toolingPack, packed[0]);
  }
  return toolingTarball;
}
