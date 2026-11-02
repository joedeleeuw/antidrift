import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  file,
  run,
  runInherit,
  runJson,
  work,
  pnpmLaunch,
} from "./consumer-process.mjs";
import {
  packParentTarball,
  packPlatformTarball,
  packToolingTarball,
} from "./consumer-packaging.mjs";
import {
  installedConsumerPackages,
  provePackedAddon,
  proveMissingAddon,
  provePackedRust,
} from "./consumer-installed-runtime.mjs";
import {
  proveGeneratedHook,
  proveConfiguredRules,
  lintOxlint,
  lintOxlintRepository,
  proveReactNativePolicy,
  proveFallbackPolicy,
  proveRulePrecedence,
} from "./consumer-configuration.mjs";
import {
  proveModuleSizeDiagnostics,
  proveRepositoryRuleDiagnostics,
  proveCleanRepositoryFiles,
} from "./consumer-repository-diagnostics.mjs";
import { proveAdoptionPresets } from "./consumer-adoption.mjs";
import { scaffoldConsumerWorkspace } from "./consumer-workspace.mjs";

const tarball = packParentTarball();
const { platformKey, platformTarball, platformManifest } =
  packPlatformTarball();
const platformPackageName = platformManifest.name;
console.log("2/6  scaffolding a consumer pnpm workspace ...");
const toolingTarball = packToolingTarball();
scaffoldConsumerWorkspace({
  file,
  tarball,
  toolingTarball,
  platformPackageName,
  platformTarball,
});

console.log("3/6  installing the tarball into the consumer ...");
runInherit(
  pnpmLaunch.file,
  [
    ...pnpmLaunch.prefix,
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
  "3b/6 generating policy artifacts in the consumer and running the generated hook ..."
);
proveGeneratedHook();
console.log(
  "4/6  linting consumer files through shipped and opt-in configs ..."
);
const { installedPackageRoot, installedPlatformPackageRoot } =
  installedConsumerPackages(platformPackageName, platformTarball);
provePackedAddon(installedPackageRoot);
proveMissingAddon(installedPlatformPackageRoot, platformKey);
provePackedRust(installedPlatformPackageRoot, platformManifest);
proveAdoptionPresets({ file, runJson, lintOxlint, work });
proveConfiguredRules();
proveReactNativePolicy();
proveFallbackPolicy();
rmSync(join(work, "portable-proofs"), { recursive: true, force: true });
rmSync(join(work, "apps"), { recursive: true, force: true });
rmSync(join(work, "configured/node_modules"), {
  recursive: true,
  force: true,
});
rmSync(join(work, "adoption-proof.tsx"));
rmSync(join(work, "adoption.config.json"));

const repositoryDiagnostics = lintOxlintRepository().diagnostics ?? [];
proveModuleSizeDiagnostics(repositoryDiagnostics);
proveRepositoryRuleDiagnostics(repositoryDiagnostics);
proveCleanRepositoryFiles(repositoryDiagnostics);
proveRulePrecedence();
console.log(
  "5/6  typechecking every public export under supported TS resolution modes ..."
);
run(
  pnpmLaunch.file,
  [
    ...pnpmLaunch.prefix,
    "exec",
    "tsc",
    "-p",
    "tsconfig.bundler.json",
    "--pretty",
    "false",
  ],
  work
);
run(
  pnpmLaunch.file,
  [
    ...pnpmLaunch.prefix,
    "exec",
    "tsc",
    "-p",
    "tsconfig.nodenext.json",
    "--pretty",
    "false",
  ],
  work
);

console.log("6/6  importing every public runtime export ...");
run(process.execPath, ["packages/app/src/runtime.mjs"], work);

console.log(
  "\n✓ tarball installs, type-checks, imports, and enforces via native antidrift-linter in a consumer monorepo"
);
rmSync(work, { recursive: true, force: true });
