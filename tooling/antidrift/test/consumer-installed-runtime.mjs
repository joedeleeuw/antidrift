import { copyFileSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { ADDON_PACKAGE_PATH } from "../src/policy/oxlint.mjs";
import { file, fail, work, pnpmLaunch } from "./consumer-process.mjs";

function runPackedOxlint() {
  const completed = spawnSync(
    pnpmLaunch.file,
    [
      ...pnpmLaunch.prefix,
      "exec",
      "oxlint",
      "portable-proofs/addon.ts",
      "--format",
      "json",
      "--config",
      "oxlint.addon.config.json",
      "--tsconfig",
      "tsconfig.bundler.json",
    ],
    {
      cwd: work,
      encoding: "utf8",
      timeout: 300_000,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024 * 1024,
    }
  );
  if (completed.error) throw completed.error;
  return completed;
}

export function installedConsumerPackages(
  platformPackageName,
  platformTarball
) {
  const platformLockReference = `tarball: file:platform-pack/${basename(platformTarball)}`;
  if (
    !readFileSync(join(work, "pnpm-lock.yaml"), "utf8").includes(
      platformLockReference
    )
  ) {
    fail(
      `pnpm did not install the local platform override: ${platformLockReference}`
    );
  }
  const consumerRequire = createRequire(join(work, "package.json"));
  const installedPackageRoot = dirname(
    consumerRequire.resolve("@joedeleeuw/antidrift/package.json")
  );
  const installedParentRequire = createRequire(
    join(installedPackageRoot, "package.json")
  );
  const installedPlatformPackageRoot = dirname(
    realpathSync.native(
      installedParentRequire.resolve(`${platformPackageName}/package.json`)
    )
  );
  console.log(`  local platform package: ${installedPlatformPackageRoot}`);
  return { installedPackageRoot, installedPlatformPackageRoot };
}

export function provePackedAddon(installedPackageRoot) {
  file(
    "oxlint.addon.config.json",
    JSON.stringify({
      jsPlugins: [join(installedPackageRoot, "dist/oxlint-plugin/index.mjs")],
      categories: { correctness: "off" },
      rules: { "antidrift/no-as-never": "warn" },
    })
  );
  file(
    "portable-proofs/addon.ts",
    "export const castAway = (value: unknown) => value as never;\n"
  );
  const packedAddonRun = runPackedOxlint();
  if (packedAddonRun.status !== 0) {
    fail(
      `packed Oxlint plugin must exit 0 for a warning: ${packedAddonRun.stdout}${packedAddonRun.stderr}`
    );
  }
  const addonFinding = JSON.parse(packedAddonRun.stdout).diagnostics?.find(
    ({ code, severity }) =>
      code === "antidrift(no-as-never)" && severity === "warning"
  );
  if (!addonFinding) {
    fail(
      `packed Oxlint plugin must report antidrift/no-as-never as a warning: ${packedAddonRun.stdout}`
    );
  }
  console.log(
    `  packed plugin finding: ${addonFinding.code} (${addonFinding.severity}) ${addonFinding.message}`
  );
}

export function proveMissingAddon(platformRoot, platformKey) {
  const installedAddon = join(platformRoot, ADDON_PACKAGE_PATH);
  rmSync(installedAddon);
  const missingAddonRun = runPackedOxlint();
  const missingAddonOutput = `${missingAddonRun.stdout}${missingAddonRun.stderr}`;
  const expectedMissingAddon = `Missing the antidrift Oxlint addon for ${platformKey}`;
  if (
    missingAddonRun.status === 0 ||
    !missingAddonOutput.includes(expectedMissingAddon)
  ) {
    fail(
      `removing the packed addon must fail with ${expectedMissingAddon}: ${missingAddonOutput}`
    );
  }
  console.log(`  missing addon failure: ${expectedMissingAddon}`);
  copyFileSync(
    join(work, "platform-package", ADDON_PACKAGE_PATH),
    installedAddon
  );
  rmSync(join(work, "portable-proofs/addon.ts"));
  rmSync(join(work, "oxlint.addon.config.json"));
}

export function provePackedRust(platformRoot, platformManifest) {
  const packedLinter = join(platformRoot, platformManifest.main);
  file(
    "rust-proofs/Cargo.toml",
    '[package]\nname = "rust-proofs"\nversion = "0.1.0"\nedition = "2024"\n'
  );
  file(
    "rust-proofs/src/lib.rs",
    'pub fn parse_port(text: &str) -> Result<u16, String> {\n    text.parse::<u16>().map_err(|_| "bad port".to_owned())\n}\n'
  );
  const packedRustRun = spawnSync(
    packedLinter,
    ["rust", "--format", "json", "rust-proofs"],
    {
      cwd: work,
      encoding: "utf8",
      timeout: 300_000,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024 * 1024,
    }
  );
  if (packedRustRun.error) throw packedRustRun.error;
  const rustFinding =
    packedRustRun.status === 1
      ? JSON.parse(packedRustRun.stdout).find(
          ({ ruleId, file: findingFile }) =>
            ruleId === "rust/no-anemic-errors" && findingFile.endsWith("lib.rs")
        )
      : undefined;
  if (!rustFinding) {
    fail(
      `packed antidrift-linter rust must exit 1 with rust/no-anemic-errors in rust-proofs/src/lib.rs: ${packedRustRun.status} ${packedRustRun.stdout}${packedRustRun.stderr}`
    );
  }
  console.log(
    `  packed rust finding: ${rustFinding.ruleId} ${rustFinding.file}:${rustFinding.line}`
  );
  rmSync(join(work, "rust-proofs"), { recursive: true });
}
