import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ADDON_PACKAGE_PATH,
  LINTER_PLATFORM_KEYS,
} from "../src/policy/oxlint.mjs";
import { proveAdoptionPresets } from "./consumer-adoption.mjs";
import { scaffoldConsumerWorkspace } from "./consumer-workspace.mjs";

const pnpmBinary = process.env.ANTIDRIFT_CONSUMER_PNPM ?? "pnpm";

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const work = mkdtempSync(join(tmpdir(), "antidrift-consumer-"));

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 300_000,
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function runInherit(cmd, args, cwd) {
  return execFileSync(cmd, args, {
    cwd,
    stdio: "inherit",
    timeout: 300_000,
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function runJson(cmd, args, cwd) {
  return JSON.parse(run(cmd, args, cwd));
}

function file(rel, fileContents) {
  const targetPath = join(work, rel);
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, fileContents, "utf8");
}

function fail(message) {
  console.error(`\n✗ ${message}`);
  console.error(`  (left workspace for inspection: ${work})`);
  process.exit(1);
}

try {
  console.log("1/6  packing @joedeleeuw/antidrift ...");
  run("pnpm", ["pack", "--pack-destination", work], pkgDir);
  const tgz = readdirSync(work).find((filename) => filename.endsWith(".tgz"));
  if (!tgz) fail("pack produced no tarball");
  const tarball = join(work, tgz);
  const packedFiles = new Set(
    run("tar", ["-tzf", tarball], work).trim().split("\n")
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

  const hostPlatform = `${process.platform}-${process.arch}`;
  const platformKey = LINTER_PLATFORM_KEYS[hostPlatform];
  if (!platformKey) fail(`Unsupported host platform: ${hostPlatform}`);
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
  const platformManifest = JSON.parse(
    readFileSync(join(platformPackageDirectory, "package.json"), "utf8")
  );
  const platformPackageName = platformManifest.name;
  const platformPack = join(work, "platform-pack");
  mkdirSync(platformPack);
  run(
    pnpmBinary,
    ["pack", "--pack-destination", platformPack],
    platformPackageDirectory
  );
  const platformTarballs = readdirSync(platformPack).filter((name) =>
    name.endsWith(".tgz")
  );
  if (platformTarballs.length !== 1) {
    fail("platform pack must produce exactly one tarball");
  }
  const platformTarball = join(platformPack, platformTarballs[0]);
  const platformTarballContents = run(
    "tar",
    ["-tzf", platformTarball],
    work
  ).trim();
  console.log(`  platform tarball contents:\n${platformTarballContents}`);
  const platformPackedFiles = new Set(platformTarballContents.split("\n"));
  for (const required of [
    `package/${ADDON_PACKAGE_PATH}`,
    `package/${platformManifest.main}`,
  ]) {
    if (!platformPackedFiles.has(required)) {
      fail(`platform tarball missing required artifact: ${required}`);
    }
  }

  console.log("2/6  scaffolding a consumer pnpm workspace ...");
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
    run(pnpmBinary, ["pack", "--pack-destination", toolingPack], toolingRoot);
    const packed = readdirSync(toolingPack).filter((name) =>
      name.endsWith(".tgz")
    );
    if (packed.length !== 1) {
      fail("tooling pack must produce exactly one tarball");
    }
    toolingTarball = join(toolingPack, packed[0]);
  }
  scaffoldConsumerWorkspace({
    file,
    tarball,
    toolingTarball,
    platformPackageName,
    platformTarball,
  });

  console.log("3/6  installing the tarball into the consumer ...");
  runInherit(
    pnpmBinary,
    [
      "install",
      process.env.ANTIDRIFT_CONSUMER_OFFLINE === "1"
        ? "--offline"
        : "--prefer-offline",
      "--config.confirmModulesPurge=false",
      "--ignore-scripts",
    ],
    work
  );

  console.log(
    "4/6  linting consumer files through shipped and opt-in configs ..."
  );

  function runPackedOxlint() {
    const completed = spawnSync(
      pnpmBinary,
      [
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

  const platformLockReference = `tarball: file:platform-pack/${platformTarballs[0]}`;
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
    realpathSync(
      installedParentRequire.resolve(`${platformPackageName}/package.json`)
    )
  );
  console.log(`  local platform package: ${installedPlatformPackageRoot}`);
  const installedAddon = join(installedPlatformPackageRoot, ADDON_PACKAGE_PATH);
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

  rmSync(installedAddon);
  const missingAddonRun = runPackedOxlint();
  const missingAddonOutput = `${missingAddonRun.stdout}${missingAddonRun.stderr}`;
  const expectedMissingAddon = `Missing the antidrift Oxlint addon for ${process.platform}-${process.arch}`;
  if (
    missingAddonRun.status === 0 ||
    !missingAddonOutput.includes(expectedMissingAddon)
  ) {
    fail(
      `removing the packed addon must fail with ${expectedMissingAddon}: ${missingAddonOutput}`
    );
  }
  console.log(`  missing addon failure: ${expectedMissingAddon}`);
  rmSync(join(work, "portable-proofs/addon.ts"));
  rmSync(join(work, "oxlint.addon.config.json"));

  const packedLinter = join(
    installedPlatformPackageRoot,
    platformManifest.main
  );
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

  function lintOxlint(relFile, config) {
    try {
      return runJson(
        pnpmBinary,
        [
          "exec",
          "oxlint",
          relFile,
          "--format",
          "json",
          "--config",
          config,
          "--tsconfig",
          "tsconfig.bundler.json",
        ],
        work
      );
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "stdout" in error &&
        typeof error.stdout === "string"
      ) {
        return JSON.parse(error.stdout);
      }
      throw error;
    }
  }

  function lintAntidriftOxlint(relFile, config) {
    try {
      return runJson(
        pnpmBinary,
        [
          "exec",
          "antidrift",
          "oxlint",
          relFile,
          "--",
          "--format",
          "json",
          "--config",
          config,
          "--tsconfig",
          "tsconfig.bundler.json",
        ],
        work
      );
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "stdout" in error &&
        typeof error.stdout === "string"
      ) {
        return JSON.parse(error.stdout);
      }
      throw error;
    }
  }

  function lintOxlintRepository() {
    try {
      return runJson(
        pnpmBinary,
        [
          "exec",
          "antidrift",
          "oxlint",
          "--",
          "--format",
          "json",
          "--config",
          "oxlint.config.mjs",
        ],
        work
      );
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "stdout" in error &&
        typeof error.stdout === "string"
      ) {
        return JSON.parse(error.stdout);
      }
      throw error;
    }
  }

  function oxlintRuleIds(output) {
    return (output.diagnostics ?? []).map(({ code }) => {
      const match = /^([^()]+)\(([^()]+)\)$/u.exec(code ?? "");
      return match ? `${match[1]}/${match[2]}` : code;
    });
  }

  proveAdoptionPresets({ file, runJson, lintOxlint, work });

  const unconfiguredTouchableRules = oxlintRuleIds(
    lintOxlint("portable-proofs/raw-touchable.tsx", "oxlint.config.mjs")
  );
  if (unconfiguredTouchableRules.includes("eslint/no-restricted-imports")) {
    fail(
      "React Native restrictions must be opt-in when no interaction owner is configured"
    );
  }
  const configuredTouchableOutput = lintOxlint(
    "portable-proofs/raw-touchable.tsx",
    "oxlint.react-native.config.mjs"
  );
  const configuredTouchableRules = oxlintRuleIds(configuredTouchableOutput);
  if (!configuredTouchableRules.includes("eslint/no-restricted-imports")) {
    fail("Configured React Native policy must reject a raw Pressable import");
  }
  const restrictedMessages = (configuredTouchableOutput.diagnostics ?? []).map(
    ({ message }) => message
  );
  for (const expected of [
    "'default' import",
    "* import is invalid",
    "'TouchableOpacity' import",
  ]) {
    if (!restrictedMessages.some((message) => message.includes(expected))) {
      fail(
        `React Native restrictions must cover default, namespace and re-export forms; missing ${expected}: ${JSON.stringify(restrictedMessages)}`
      );
    }
  }
  for (const allowed of [
    "portable-proofs/tw/index.tsx",
    "portable-proofs/type-only-touchable.tsx",
  ]) {
    if (
      oxlintRuleIds(
        lintOxlint(allowed, "oxlint.react-native.config.mjs")
      ).includes("eslint/no-restricted-imports")
    ) {
      fail(
        `React Native owner and type-only imports must stay clean: ${allowed}`
      );
    }
  }

  const fallbackConfig = "nested/oxlint.fallback.config.mjs";
  const fallbackOutput = lintAntidriftOxlint(
    "portable-proofs/fallback.ts",
    fallbackConfig
  );
  const fallbackRules = oxlintRuleIds(fallbackOutput);
  const hostPathDiagnostics = (fallbackOutput.diagnostics ?? []).filter(
    ({ message }) => message.includes("Host-absolute path literal")
  );
  if (
    !fallbackRules.includes("@rikalabs/no-property-default-fallbacks") ||
    !fallbackRules.includes("typescript/antidrift/no-host-path-literal") ||
    hostPathDiagnostics.length !== 2
  ) {
    fail(
      `Fallback opt-in must enforce Rika defaults and both host-path literal forms, got: ${JSON.stringify(fallbackOutput.diagnostics)}`
    );
  }
  if (
    !fallbackRules.includes("typescript/antidrift/no-sentinel-absence-fallback")
  ) {
    fail("Template-literal sentinels must remain covered when Rika is enabled");
  }
  const allowedFallbackRules = oxlintRuleIds(
    lintAntidriftOxlint("portable-proofs/allowed-fallback.ts", fallbackConfig)
  );
  if (
    allowedFallbackRules.includes("@rikalabs/no-property-default-fallbacks") ||
    allowedFallbackRules.includes("typescript/antidrift/no-host-path-literal")
  ) {
    fail(
      `Nested config must honor repo-relative fallback exceptions, got: ${JSON.stringify(allowedFallbackRules)}`
    );
  }

  rmSync(join(work, "portable-proofs"), { recursive: true, force: true });
  rmSync(join(work, "adoption-proof.tsx"));
  rmSync(join(work, "adoption.config.json"));

  const repositoryDiagnostics = lintOxlintRepository().diagnostics ?? [];
  const moduleSizeDiagnostics = repositoryDiagnostics.filter(
    ({ code }) => code === "typescript(antidrift/max-module-lines)"
  );
  const oversizedFiles = moduleSizeDiagnostics
    .map(({ filename }) => filename)
    .sort();
  const expectedOversizedFiles = [
    "convex/oversized.ts",
    "oversized-root.ts",
    "scripts/oversized-script.ts",
    "src/_generated/oversized.ts",
    "src/fixtures/helper.ts",
    "src/generated/oversized.ts",
    "src/undeclared.gen.ts",
    "src/undeclared.generated.ts",
    "tests/oversized-test.ts",
  ].sort();
  if (
    JSON.stringify(oversizedFiles) !== JSON.stringify(expectedOversizedFiles)
  ) {
    fail(
      `default packed Oxlint config should report antidrift/max-module-lines for ordinary code even when generated-looking names are undeclared, got: ${JSON.stringify(moduleSizeDiagnostics)}`
    );
  }
  const asyncRepositoryDiagnostics = repositoryDiagnostics.filter(
    ({ code }) => code === "typescript(antidrift/no-async-array-method)"
  );
  if (
    JSON.stringify(
      asyncRepositoryDiagnostics.map(({ filename }) => filename)
    ) !== JSON.stringify(["packages/app/src/async-foreach-drift.ts"])
  ) {
    fail(
      `default packed Oxlint config should report antidrift/no-async-array-method via native antidrift-linter on async-foreach-drift.ts, got: ${JSON.stringify(repositoryDiagnostics)}`
    );
  }
  const predicateDiagnostics = repositoryDiagnostics.filter(
    ({ code }) =>
      code === "typescript(antidrift/no-underchecked-type-predicate)"
  );
  if (
    JSON.stringify(predicateDiagnostics.map(({ filename }) => filename)) !==
    JSON.stringify(["packages/app/src/underchecked-predicate.ts"])
  ) {
    fail(
      `default packed Oxlint config should report antidrift/no-underchecked-type-predicate via native antidrift-linter, got: ${JSON.stringify(repositoryDiagnostics)}`
    );
  }
  const structuralForkDiagnostics = repositoryDiagnostics.filter(
    ({ code }) => code === "typescript(antidrift/no-structural-type-fork)"
  );
  if (
    JSON.stringify(
      structuralForkDiagnostics.map(({ filename }) => filename)
    ) !== JSON.stringify(["packages/app/src/drift.ts"])
  ) {
    fail(
      `default packed Oxlint config should report antidrift/no-structural-type-fork on drift.ts (and NOT on unaccepted package-copy.ts), got: ${JSON.stringify(repositoryDiagnostics)}`
    );
  }
  const cleanDiagnostics = repositoryDiagnostics.filter(
    ({ filename }) =>
      filename === "packages/app/src/clean.ts" ||
      filename === "packages/app/src/package-copy.ts" ||
      filename === "packages/app/src/brand.ts" ||
      filename === "packages/app/src/exports.ts"
  );
  if (cleanDiagnostics.length > 0) {
    fail(
      `clean.ts, package-copy.ts, brand.ts, and exports.ts must remain clean, got: ${JSON.stringify(cleanDiagnostics)}`
    );
  }

  const composedRuleIds = oxlintRuleIds(
    lintOxlint("precedence-proof.ts", "oxlint.config.mjs")
  );
  const precedenceRuleIds = oxlintRuleIds(
    lintOxlint("precedence-proof.ts", "oxlint.precedence.config.mjs")
  );
  if (
    !composedRuleIds.includes("eslint/no-nested-ternary") ||
    precedenceRuleIds.includes("eslint/no-nested-ternary")
  ) {
    fail(
      `consumer rules composed after tooling and governance must win, got: ${JSON.stringify({ composedRuleIds, precedenceRuleIds })}`
    );
  }

  console.log(
    "5/6  typechecking every public export under supported TS resolution modes ..."
  );
  run(
    pnpmBinary,
    ["exec", "tsc", "-p", "tsconfig.bundler.json", "--pretty", "false"],
    work
  );
  run(
    pnpmBinary,
    ["exec", "tsc", "-p", "tsconfig.nodenext.json", "--pretty", "false"],
    work
  );

  console.log("6/6  importing every public runtime export ...");
  run("node", ["packages/app/src/runtime.mjs"], work);

  console.log(
    `\n✓ tarball installs, type-checks, imports, and enforces via native antidrift-linter in a consumer monorepo`
  );
  rmSync(work, { recursive: true, force: true });
} catch (error) {
  console.error(error.stdout || error.stderr || error.message || error);
  fail("integration run threw");
}
