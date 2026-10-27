import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { provePortableRules } from "./consumer-portable.mjs";
import { proveAdoptionPresets } from "./consumer-adoption.mjs";

import { scaffoldConsumerWorkspace } from "./consumer-workspace.mjs";
import {
  proveStructuralContracts,
  scaffoldStructuralContracts,
} from "./consumer-structural.mjs";
import {
  provePrecisionRules,
  scaffoldPrecisionProofs,
} from "./consumer-precision.mjs";

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
  console.log("1/7  packing @joedeleeuw/antidrift ...");
  run("pnpm", ["pack", "--pack-destination", work], pkgDir);
  const tgz = readdirSync(work).find((filename) => filename.endsWith(".tgz"));
  if (!tgz) fail("pack produced no tarball");
  const tarball = join(work, tgz);
  const packedFiles = new Set(
    run("tar", ["-tzf", tarball], work).trim().split("\n")
  );
  const shippedTestSupport = [
    "package/src/eslint-plugin/test-harness.mjs",
    "package/src/policy/registry-test-workspace.mjs",
    "package/test/support/eslint-plugin-harness.mjs",
    "package/test/support/registry-workspace.mjs",
  ].filter((path) => packedFiles.has(path));
  if (shippedTestSupport.length > 0) {
    fail(
      `tarball must not ship test support: ${shippedTestSupport.join(", ")}`
    );
  }

  console.log("2/7  scaffolding a consumer pnpm workspace ...");
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
  scaffoldConsumerWorkspace({ file, tarball, toolingTarball });
  scaffoldStructuralContracts({ file, work });
  scaffoldPrecisionProofs({ file, work });

  console.log("3/7  installing the tarball into the consumer ...");
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
    "4/7  linting consumer files through shipped and opt-in configs ..."
  );
  const semanticFactFile = join(work, "semantic-facts.jsonl");
  rmSync(semanticFactFile, { force: true });

  function lint(relFile, config = "eslint.config.mjs") {
    try {
      return runJson(
        pnpmBinary,
        ["exec", "eslint", relFile, "--format", "json", "--config", config],
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

  provePortableRules({ file, lintOxlint, packedFiles });
  proveAdoptionPresets({ file, runJson, lintOxlint, work });
  provePrecisionRules({ lint, lintOxlint });

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
  const fallbackOutput = lintOxlint(
    "portable-proofs/fallback.ts",
    fallbackConfig
  );
  const fallbackRules = oxlintRuleIds(fallbackOutput);
  const hostPathDiagnostics = (fallbackOutput.diagnostics ?? []).filter(
    ({ message }) => message.includes("Host-absolute path literal")
  );
  if (
    !fallbackRules.includes("@rikalabs/no-property-default-fallbacks") ||
    !fallbackRules.includes("governance-eslint/no-restricted-syntax") ||
    hostPathDiagnostics.length !== 2
  ) {
    fail(
      `Fallback opt-in must enforce Rika defaults and both host-path selector forms, got: ${JSON.stringify(fallbackOutput.diagnostics)}`
    );
  }
  if (
    !(fallbackOutput.diagnostics ?? []).some(({ message }) =>
      message.includes("hides a missing member behind a sentinel")
    )
  ) {
    fail("Template-literal sentinels must remain covered when Rika is enabled");
  }
  const allowedFallbackRules = oxlintRuleIds(
    lintOxlint("portable-proofs/allowed-fallback.ts", fallbackConfig)
  );
  if (
    allowedFallbackRules.includes("@rikalabs/no-property-default-fallbacks") ||
    allowedFallbackRules.includes("governance-eslint/no-restricted-syntax")
  ) {
    fail(
      `Nested config must honor repo-relative fallback exceptions, got: ${JSON.stringify(allowedFallbackRules)}`
    );
  }

  const defaultFallbackRules = lint(
    "packages/app/src/fallback-policy.ts"
  ).flatMap((lintResult) => lintResult.messages.map(({ ruleId }) => ruleId));
  if (
    !defaultFallbackRules.includes("antidrift/no-sentinel-absence-fallback")
  ) {
    fail(
      "The narrow sentinel rule must remain enabled without the Rika opt-in"
    );
  }
  const delegatedFallbackRules = lint(
    "packages/app/src/fallback-policy.ts",
    "eslint.fallback.config.mjs"
  ).flatMap((lintResult) => lintResult.messages.map(({ ruleId }) => ruleId));
  if (
    delegatedFallbackRules.includes("antidrift/no-sentinel-absence-fallback") ||
    !delegatedFallbackRules.includes("no-restricted-syntax")
  ) {
    fail(
      `Rika opt-in must disable the overlapping custom rule but retain template sentinels, got: ${JSON.stringify(delegatedFallbackRules)}`
    );
  }

  rmSync(join(work, "portable-proofs"), { recursive: true, force: true });
  rmSync(join(work, "portable.config.json"));
  rmSync(join(work, "adoption-proof.tsx"));
  rmSync(join(work, "adoption.config.json"));
  rmSync(join(work, "precision-proofs"), { recursive: true, force: true });
  rmSync(join(work, "precision.config.json"));

  const repositoryDiagnostics = lintOxlintRepository().diagnostics ?? [];
  const moduleSizeDiagnostics = repositoryDiagnostics.filter(
    ({ code }) => code === "eslint(max-lines)"
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
      `default packed Oxlint config should report max-lines for ordinary code even when generated-looking names are undeclared, got: ${JSON.stringify(moduleSizeDiagnostics)}`
    );
  }
  const asyncRepositoryDiagnostics = repositoryDiagnostics.filter(
    ({ code }) => code === "antidrift(no-async-array-method)"
  );
  if (
    JSON.stringify(
      asyncRepositoryDiagnostics.map(({ filename }) => filename)
    ) !== JSON.stringify(["packages/app/src/async-foreach-drift.ts"])
  ) {
    fail(
      `default packed Oxlint config should report no-async-array-method on async-foreach-drift.ts, got: ${JSON.stringify(asyncRepositoryDiagnostics)}`
    );
  }
  const sharedRuleDiagnostics = repositoryDiagnostics.filter(
    ({ code }) =>
      code !== "eslint(max-lines)" &&
      code !== "antidrift(no-async-array-method)"
  );
  if (sharedRuleDiagnostics.length > 0) {
    fail(
      `default packed Oxlint config should leave experimental imported rules disabled, got: ${JSON.stringify(sharedRuleDiagnostics)}`
    );
  }
  const precedenceRuleIds = oxlintRuleIds(
    lintOxlint("oversized-root.ts", "oxlint.precedence.config.mjs")
  );
  if (precedenceRuleIds.includes("eslint/max-lines")) {
    fail(
      `consumer rules composed after tooling and governance must win, got: ${JSON.stringify(precedenceRuleIds)}`
    );
  }

  const RULE = "antidrift/no-structural-type-fork";
  const defaultCleanRules = lint("packages/app/src/clean.ts").flatMap(
    (lintResult) => lintResult.messages.map((message) => message.ruleId)
  );
  const defaultDriftRules = lint("packages/app/src/drift.ts").flatMap(
    (lintResult) => lintResult.messages.map((message) => message.ruleId)
  );
  if (defaultCleanRules.includes(RULE)) {
    fail(
      `default config must accept clean.ts without ${RULE}, got: ${JSON.stringify(defaultCleanRules)}`
    );
  }
  if (!defaultDriftRules.includes(RULE)) {
    fail(
      `default config must load generated owner facts and report ${RULE}, got: ${JSON.stringify(defaultDriftRules)}`
    );
  }

  proveStructuralContracts({ file, lint });

  const restrictedSyntaxMessages = lint(
    "packages/app/src/restricted-syntax-drift.ts"
  ).flatMap((lintResult) =>
    lintResult.messages
      .filter((message) => message.ruleId === "no-restricted-syntax")
      .map((message) => message.message)
  );
  const declaresEnum = restrictedSyntaxMessages.some((message) =>
    message.includes("Do not declare enums")
  );
  const usesForwardRef = restrictedSyntaxMessages.some((message) =>
    message.includes("forwardRef is deprecated")
  );
  if (!declaresEnum || !usesForwardRef) {
    fail(
      `default config must report the enum declaration and the forwardRef call, got: ${JSON.stringify(restrictedSyntaxMessages)}`
    );
  }
  if (
    defaultCleanRules.includes("no-restricted-syntax") ||
    restrictedSyntaxMessages.length !== 2
  ) {
    fail(
      `no-restricted-syntax must fire exactly twice on the probe and stay off clean.ts, got: ${JSON.stringify({ clean: defaultCleanRules, probe: restrictedSyntaxMessages })}`
    );
  }

  const packageCopyRules = lint("packages/app/src/package-copy.ts").flatMap(
    (lintResult) => lintResult.messages.map((message) => message.ruleId)
  );
  const undercheckedPredicateRules = lint(
    "packages/app/src/underchecked-predicate.ts"
  ).flatMap((lintResult) =>
    lintResult.messages.map((message) => message.ruleId)
  );

  if (packageCopyRules.includes(RULE)) {
    fail(
      `package-copy.ts (unaccepted package authority) must NOT report ${RULE}, got: ${JSON.stringify(packageCopyRules)}`
    );
  }
  const UNDERCHECKED_PREDICATE_RULE =
    "antidrift/no-underchecked-type-predicate";
  if (!undercheckedPredicateRules.includes(UNDERCHECKED_PREDICATE_RULE)) {
    fail(
      `TypeScript 6 consumer should report ${UNDERCHECKED_PREDICATE_RULE} for an under-checked object predicate, got: ${JSON.stringify(undercheckedPredicateRules)}`
    );
  }

  const mergedProjectionMessages = lint(
    "packages/app/src/merged-projections.ts"
  ).flatMap((lintResult) => lintResult.messages);
  const propertyHops = mergedProjectionMessages.filter(
    (message) => message.ruleId === "antidrift/no-wrapping-functions"
  );
  const bagDiagnosticIds = new Set(
    mergedProjectionMessages
      .filter(
        (message) =>
          message.ruleId === "antidrift/no-contract-appeasement-projection"
      )
      .map((message) => message.messageId)
  );
  if (
    propertyHops.length !== 2 ||
    propertyHops.some((message) => message.messageId !== "hop")
  ) {
    fail(
      `direct and fallback property helpers should each report a verified hop without name-only reports, got: ${JSON.stringify(mergedProjectionMessages)}`
    );
  }
  const expectedBagIds = new Set(["bagToContract", "bagToBag"]);
  if (
    bagDiagnosticIds.size !== expectedBagIds.size ||
    [...expectedBagIds].some((id) => !bagDiagnosticIds.has(id))
  ) {
    fail(
      `merged projection rule should report both bag cases, got: ${JSON.stringify(mergedProjectionMessages)}`
    );
  }

  const ASYNC_RULE = "antidrift/no-async-array-method";
  const asyncDefaultConfig = "oxlint.async-array.config.mjs";
  const asyncCollectionConfig = "oxlint.async-array-collection.config.mjs";
  const asyncForEachRules = oxlintRuleIds(
    lintOxlint("packages/app/src/async-foreach-drift.ts", asyncDefaultConfig)
  );
  const asyncMapDefaultRules = oxlintRuleIds(
    lintOxlint(
      "packages/app/src/async-map-collection-drift.ts",
      asyncDefaultConfig
    )
  );
  const asyncMapCollectionRules = oxlintRuleIds(
    lintOxlint(
      "packages/app/src/async-map-collection-drift.ts",
      asyncCollectionConfig
    )
  );
  const asyncMapReturnRules = oxlintRuleIds(
    lintOxlint(
      "packages/app/src/async-map-return-clean.ts",
      asyncCollectionConfig
    )
  );

  if (!asyncForEachRules.includes(ASYNC_RULE)) {
    fail(
      `explicit async-array config should report forEach drift, got: ${JSON.stringify(asyncForEachRules)}`
    );
  }
  if (asyncMapDefaultRules.includes(ASYNC_RULE)) {
    fail(
      `default async-array branch must not report map collection flow, got: ${JSON.stringify(asyncMapDefaultRules)}`
    );
  }
  if (!asyncMapCollectionRules.includes(ASYNC_RULE)) {
    fail(
      `opt-in async-array collection branch should report unjoined map flow, got: ${JSON.stringify(asyncMapCollectionRules)}`
    );
  }
  if (asyncMapReturnRules.includes(ASYNC_RULE)) {
    fail(
      `opt-in async-array collection branch must not report returned promise arrays, got: ${JSON.stringify(asyncMapReturnRules)}`
    );
  }

  const semanticFacts = readFileSync(semanticFactFile, "utf8")
    .trim()
    .split(/\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const generatedStructuralFact = semanticFacts.find(
    (fact) =>
      fact.factKind === "structuralMatch" &&
      fact.ruleId === RULE &&
      fact.confidence === "deterministic-enforcement" &&
      fact.payload?.authorityState === "accepted" &&
      fact.payload?.ownerType?.authority === "generated-source" &&
      fact.filePath === "packages/app/src/drift.ts"
  );

  if (!generatedStructuralFact) {
    fail(
      `default config drift.ts should have emitted a generated-source structuralMatch fact, got: ${JSON.stringify(semanticFacts)}`
    );
  }

  console.log(
    "5/7  reading the shipped semantic adapter manifest from the CLI ..."
  );
  const semanticManifest = runJson(
    pnpmBinary,
    ["exec", "antidrift", "semantic-manifest"],
    work
  );
  const reactStateManifest = semanticManifest.find(
    (entry) => entry.id === "react-state"
  );
  const typeOwnerManifest = semanticManifest.find(
    (entry) => entry.id === "type-owner"
  );

  if (
    reactStateManifest?.semanticFactContracts
      ?.map((entry) => entry.factKind)
      .join(",") !==
      "broadSetterCoMutation,resourceLifecycleProof,sourceMemberStateShardCandidate" ||
    !typeOwnerManifest?.proofBuckets?.includes("authority-index-ownership")
  ) {
    fail(
      `semantic-manifest should expose composed adapter/fact metadata, got: ${JSON.stringify(semanticManifest)}`
    );
  }
  const reactStateSemanticManifest = runJson(
    pnpmBinary,
    [
      "exec",
      "antidrift",
      "semantic-manifest",
      "--rule",
      "antidrift/no-handrolled-resource-lifecycle-cells",
    ],
    work
  );
  const asyncControlSemanticManifest = runJson(
    pnpmBinary,
    [
      "exec",
      "antidrift",
      "semantic-manifest",
      "--rule",
      "antidrift/no-async-array-method",
    ],
    work
  );
  const tupleShapeSemanticManifest = runJson(
    pnpmBinary,
    [
      "exec",
      "antidrift",
      "semantic-manifest",
      "--rule",
      "antidrift/no-nullable-positional-tuple",
    ],
    work
  );
  const authoritySemanticManifest = runJson(
    pnpmBinary,
    [
      "exec",
      "antidrift",
      "semantic-manifest",
      "--proof-bucket",
      "authority-index-ownership",
    ],
    work
  );
  const structuralFactSemanticManifest = runJson(
    pnpmBinary,
    [
      "exec",
      "antidrift",
      "semantic-manifest",
      "--fact-kind",
      "structuralMatch",
    ],
    work
  );
  const typeOwnerFactSemanticManifest = runJson(
    pnpmBinary,
    [
      "exec",
      "antidrift",
      "semantic-manifest",
      "--fact-adapter",
      "typescript-eslint/type-owner",
    ],
    work
  );

  if (
    reactStateSemanticManifest.map((entry) => entry.id).join(",") !==
      "react-state" ||
    asyncControlSemanticManifest.map((entry) => entry.id).join(",") !==
      "async-control-flow" ||
    tupleShapeSemanticManifest.map((entry) => entry.id).join(",") !==
      "tuple-shape" ||
    authoritySemanticManifest.map((entry) => entry.id).join(",") !==
      "type-owner" ||
    structuralFactSemanticManifest.map((entry) => entry.id).join(",") !==
      "type-owner" ||
    typeOwnerFactSemanticManifest.map((entry) => entry.id).join(",") !==
      "type-owner"
  ) {
    fail(
      `semantic-manifest filters should expose rule/proof/fact slices, got: ${JSON.stringify({ reactStateSemanticManifest, asyncControlSemanticManifest, tupleShapeSemanticManifest, authoritySemanticManifest, structuralFactSemanticManifest, typeOwnerFactSemanticManifest })}`
    );
  }
  console.log(
    "6/7  typechecking every public export under supported TS resolution modes ..."
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

  console.log("7/7  importing every public runtime export ...");
  run("node", ["packages/app/src/runtime.mjs"], work);

  console.log(
    `\n✓ tarball installs, type-checks, imports, and enforces in a consumer monorepo`
  );
  console.log(
    `  composed tooling and governance rejected oversized root, Convex, script, fixture, test, and undeclared generated-looking modules while ignoring registry-declared generated code, declarations, and raw JSON; consumer precedence disabled max-lines, the default typed config loaded registry owners and fired ${RULE} on drift.ts, the default typed config checked a TypeScript 6 broad-input predicate, async-array shipped behavior matched default and opt-in branch expectations, a structuralMatch fact was emitted, and clean.ts/package-copy.ts stayed clean; public exports and semantic adapters passed Bundler and NodeNext.`
  );
  rmSync(work, { recursive: true, force: true });
} catch (error) {
  console.error(error.stdout || error.stderr || error.message || error);
  fail("integration run threw");
}
