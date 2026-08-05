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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { scaffoldConsumerWorkspace } from "./consumer-workspace.mjs";

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

function file(rel, contents) {
  const path = join(work, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf8");
}

function fail(message) {
  console.error(`\n✗ ${message}`);
  console.error(`  (left workspace for inspection: ${work})`);
  process.exit(1);
}

try {
  console.log("1/7  packing @joedeleeuw/antidrift ...");
  run("pnpm", ["pack", "--pack-destination", work], pkgDir);
  const tgz = readdirSync(work).find((f) => f.endsWith(".tgz"));
  if (!tgz) fail("pack produced no tarball");
  const tarball = join(work, tgz);
  const packedFiles = new Set(
    run("tar", ["-tzf", tarball], work).trim().split("\n"),
  );
  const shippedTestSupport = [
    "package/src/eslint-plugin/test-harness.mjs",
    "package/src/policy/registry-test-workspace.mjs",
    "package/test/support/eslint-plugin-harness.mjs",
    "package/test/support/registry-workspace.mjs",
  ].filter((path) => packedFiles.has(path));
  if (shippedTestSupport.length > 0) {
    fail(
      `tarball must not ship test support: ${shippedTestSupport.join(", ")}`,
    );
  }

  console.log("2/7  scaffolding a consumer pnpm workspace ...");
  scaffoldConsumerWorkspace({ file, tarball });

  console.log("3/7  installing the tarball into the consumer ...");
  runInherit(
    "pnpm",
    [
      "install",
      "--prefer-offline",
      "--config.confirmModulesPurge=false",
      "--ignore-scripts",
    ],
    work,
  );

  console.log(
    "4/7  linting consumer files through shipped and opt-in configs ...",
  );
  const semanticFactFile = join(work, "semantic-facts.jsonl");
  rmSync(semanticFactFile, { force: true });

  function lint(relFile, config = "eslint.config.mjs") {
    try {
      return runJson(
        "pnpm",
        ["exec", "eslint", relFile, "--format", "json", "--config", config],
        work,
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
        "pnpm",
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
        work,
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
        "pnpm",
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
        work,
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

  const repositoryDiagnostics = lintOxlintRepository().diagnostics ?? [];
  const moduleSizeDiagnostics = repositoryDiagnostics.filter(
    ({ code }) => code === "eslint(max-lines)",
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
      `default packed Oxlint config should report max-lines for ordinary code even when generated-looking names are undeclared, got: ${JSON.stringify(moduleSizeDiagnostics)}`,
    );
  }
  if (repositoryDiagnostics.length !== moduleSizeDiagnostics.length) {
    fail(
      `focused governance should report only max-lines in the consumer, got: ${JSON.stringify(repositoryDiagnostics)}`,
    );
  }
  const precedenceRuleIds = oxlintRuleIds(
    lintOxlint("oversized-root.ts", "oxlint.precedence.config.mjs"),
  );
  if (precedenceRuleIds.includes("eslint/max-lines")) {
    fail(
      `consumer rules composed after governance must win, got: ${JSON.stringify(precedenceRuleIds)}`,
    );
  }

  const RULE = "antidrift/no-structural-type-fork";
  const defaultCleanRules = lint("packages/app/src/clean.ts").flatMap((r) =>
    r.messages.map((m) => m.ruleId),
  );
  const defaultDriftRules = lint("packages/app/src/drift.ts").flatMap((r) =>
    r.messages.map((m) => m.ruleId),
  );
  if (defaultCleanRules.includes(RULE)) {
    fail(
      `default config must accept clean.ts without ${RULE}, got: ${JSON.stringify(defaultCleanRules)}`,
    );
  }
  if (!defaultDriftRules.includes(RULE)) {
    fail(
      `default config must load generated owner facts and report ${RULE}, got: ${JSON.stringify(defaultDriftRules)}`,
    );
  }

  const restrictedSyntaxMessages = lint(
    "packages/app/src/restricted-syntax-drift.ts",
  ).flatMap((r) =>
    r.messages
      .filter((m) => m.ruleId === "no-restricted-syntax")
      .map((m) => m.message),
  );
  const declaresEnum = restrictedSyntaxMessages.some((m) =>
    m.includes("Do not declare enums"),
  );
  const usesForwardRef = restrictedSyntaxMessages.some((m) =>
    m.includes("forwardRef is deprecated"),
  );
  if (!declaresEnum || !usesForwardRef) {
    fail(
      `default config must report the enum declaration and the forwardRef call, got: ${JSON.stringify(restrictedSyntaxMessages)}`,
    );
  }
  if (
    defaultCleanRules.includes("no-restricted-syntax") ||
    restrictedSyntaxMessages.length !== 2
  ) {
    fail(
      `no-restricted-syntax must fire exactly twice on the probe and stay off clean.ts, got: ${JSON.stringify({ clean: defaultCleanRules, probe: restrictedSyntaxMessages })}`,
    );
  }

  const packageCopyRules = lint(
    "packages/app/src/package-copy.ts",
  ).flatMap((r) => r.messages.map((m) => m.ruleId));
  const undercheckedPredicateRules = lint(
    "packages/app/src/underchecked-predicate.ts",
    "eslint.inventory.config.mjs",
  ).flatMap((r) => r.messages.map((m) => m.ruleId));

  if (packageCopyRules.includes(RULE)) {
    fail(
      `package-copy.ts (unaccepted package authority) must NOT report ${RULE}, got: ${JSON.stringify(packageCopyRules)}`,
    );
  }
  const UNDERCHECKED_PREDICATE_RULE =
    "antidrift/no-underchecked-type-predicate";
  if (!undercheckedPredicateRules.includes(UNDERCHECKED_PREDICATE_RULE)) {
    fail(
      `TypeScript 6 consumer should report ${UNDERCHECKED_PREDICATE_RULE} for an under-checked object predicate, got: ${JSON.stringify(undercheckedPredicateRules)}`,
    );
  }

  const ASYNC_RULE = "antidrift/no-async-array-method";
  const asyncDefaultConfig = "oxlint.async-array.config.mjs";
  const asyncCollectionConfig = "oxlint.async-array-collection.config.mjs";
  const asyncForEachRules = oxlintRuleIds(
    lintOxlint("packages/app/src/async-foreach-drift.ts", asyncDefaultConfig),
  );
  const asyncMapDefaultRules = oxlintRuleIds(
    lintOxlint(
      "packages/app/src/async-map-collection-drift.ts",
      asyncDefaultConfig,
    ),
  );
  const asyncMapCollectionRules = oxlintRuleIds(
    lintOxlint(
      "packages/app/src/async-map-collection-drift.ts",
      asyncCollectionConfig,
    ),
  );
  const asyncMapReturnRules = oxlintRuleIds(
    lintOxlint(
      "packages/app/src/async-map-return-clean.ts",
      asyncCollectionConfig,
    ),
  );

  if (!asyncForEachRules.includes(ASYNC_RULE)) {
    fail(
      `explicit async-array config should report forEach drift, got: ${JSON.stringify(asyncForEachRules)}`,
    );
  }
  if (asyncMapDefaultRules.includes(ASYNC_RULE)) {
    fail(
      `default async-array branch must not report map collection flow, got: ${JSON.stringify(asyncMapDefaultRules)}`,
    );
  }
  if (!asyncMapCollectionRules.includes(ASYNC_RULE)) {
    fail(
      `opt-in async-array collection branch should report unjoined map flow, got: ${JSON.stringify(asyncMapCollectionRules)}`,
    );
  }
  if (asyncMapReturnRules.includes(ASYNC_RULE)) {
    fail(
      `opt-in async-array collection branch must not report returned promise arrays, got: ${JSON.stringify(asyncMapReturnRules)}`,
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
      fact.filePath === "packages/app/src/drift.ts",
  );

  if (!generatedStructuralFact) {
    fail(
      `default config drift.ts should have emitted a generated-source structuralMatch fact, got: ${JSON.stringify(semanticFacts)}`,
    );
  }

  console.log(
    "5/7  reading the shipped semantic adapter manifest from the CLI ...",
  );
  const semanticManifest = runJson(
    "pnpm",
    ["exec", "antidrift", "semantic-manifest"],
    work,
  );
  const reactStateManifest = semanticManifest.find(
    (entry) => entry.id === "react-state",
  );
  const typeOwnerManifest = semanticManifest.find(
    (entry) => entry.id === "type-owner",
  );

  if (
    reactStateManifest?.semanticFactContracts
      ?.map((entry) => entry.factKind)
      .join(",") !==
      "broadSetterCoMutation,resourceLifecycleProof,sourceMemberStateShardCandidate" ||
    !typeOwnerManifest?.proofBuckets?.includes("authority-index-ownership")
  ) {
    fail(
      `semantic-manifest should expose composed adapter/fact metadata, got: ${JSON.stringify(semanticManifest)}`,
    );
  }
  const reactStateSemanticManifest = runJson(
    "pnpm",
    [
      "exec",
      "antidrift",
      "semantic-manifest",
      "--rule",
      "antidrift/no-handrolled-resource-lifecycle-cells",
    ],
    work,
  );
  const asyncControlSemanticManifest = runJson(
    "pnpm",
    [
      "exec",
      "antidrift",
      "semantic-manifest",
      "--rule",
      "antidrift/no-async-array-method",
    ],
    work,
  );
  const tupleShapeSemanticManifest = runJson(
    "pnpm",
    [
      "exec",
      "antidrift",
      "semantic-manifest",
      "--rule",
      "antidrift/no-nullable-positional-tuple",
    ],
    work,
  );
  const authoritySemanticManifest = runJson(
    "pnpm",
    [
      "exec",
      "antidrift",
      "semantic-manifest",
      "--proof-bucket",
      "authority-index-ownership",
    ],
    work,
  );
  const structuralFactSemanticManifest = runJson(
    "pnpm",
    [
      "exec",
      "antidrift",
      "semantic-manifest",
      "--fact-kind",
      "structuralMatch",
    ],
    work,
  );
  const typeOwnerFactSemanticManifest = runJson(
    "pnpm",
    [
      "exec",
      "antidrift",
      "semantic-manifest",
      "--fact-adapter",
      "typescript-eslint/type-owner",
    ],
    work,
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
      `semantic-manifest filters should expose rule/proof/fact slices, got: ${JSON.stringify({ reactStateSemanticManifest, asyncControlSemanticManifest, tupleShapeSemanticManifest, authoritySemanticManifest, structuralFactSemanticManifest, typeOwnerFactSemanticManifest })}`,
    );
  }
  const ruleStatus = runJson(
    "pnpm",
    ["exec", "antidrift", "rule-status", "policy"],
    work,
  );
  const activeRule = ruleStatus.entries.find(
    (entry) => entry.id === "antidrift/no-structural-type-fork",
  );
  const retiredRule = ruleStatus.entries.find(
    (entry) => entry.id === "antidrift/no-status-triplet-state",
  );

  if (
    activeRule?.kind !== "active" ||
    activeRule?.external?.decision !== "own-antidrift" ||
    retiredRule?.kind !== "retired"
  ) {
    fail(
      `rule-status should expose normalized consumer rule metadata, got: ${JSON.stringify(ruleStatus)}`,
    );
  }
  const typeOwnerRuleStatus = runJson(
    "pnpm",
    [
      "exec",
      "antidrift",
      "rule-status",
      "policy",
      "--semantic-adapter",
      "type-owner",
    ],
    work,
  );
  const asyncControlRuleStatus = runJson(
    "pnpm",
    [
      "exec",
      "antidrift",
      "rule-status",
      "policy",
      "--semantic-adapter",
      "async-control-flow",
    ],
    work,
  );
  const tupleShapeRuleStatus = runJson(
    "pnpm",
    [
      "exec",
      "antidrift",
      "rule-status",
      "policy",
      "--semantic-adapter",
      "tuple-shape",
    ],
    work,
  );
  const authorityRuleStatus = runJson(
    "pnpm",
    [
      "exec",
      "antidrift",
      "rule-status",
      "policy",
      "--proof-bucket",
      "authority-index-ownership",
    ],
    work,
  );
  const localAstRuleStatus = runJson(
    "pnpm",
    [
      "exec",
      "antidrift",
      "rule-status",
      "policy",
      "--proof-bucket",
      "local-ast-source-shape",
    ],
    work,
  );
  const retiredRuleStatus = runJson(
    "pnpm",
    ["exec", "antidrift", "rule-status", "policy", "--kind", "retired"],
    work,
  );
  const ecosystemCoveredRuleStatus = runJson(
    "pnpm",
    [
      "exec",
      "antidrift",
      "rule-status",
      "policy",
      "--status",
      "ecosystem-covered",
    ],
    work,
  );
  const reactStateSemanticSummary = runJson(
    "pnpm",
    [
      "exec",
      "antidrift",
      "rule-status",
      "policy",
      "--semantic-summary",
      "--semantic-adapter",
      "react-state",
    ],
    work,
  );
  const localAstSemanticSummary = runJson(
    "pnpm",
    [
      "exec",
      "antidrift",
      "rule-status",
      "policy",
      "--semantic-summary",
      "--proof-bucket",
      "local-ast-source-shape",
    ],
    work,
  );

  if (
    typeOwnerRuleStatus.entries.map((entry) => entry.id).join(",") !==
      "antidrift/no-structural-type-fork" ||
    asyncControlRuleStatus.entries.map((entry) => entry.id).join(",") !==
      "antidrift/no-async-array-method" ||
    tupleShapeRuleStatus.entries.map((entry) => entry.id).join(",") !==
      "antidrift/no-nullable-positional-tuple" ||
    authorityRuleStatus.entries.map((entry) => entry.id).join(",") !==
      "antidrift/no-structural-type-fork" ||
    !localAstRuleStatus.entries.some(
      (entry) => entry.id === "antidrift/no-async-array-method",
    ) ||
    !localAstRuleStatus.entries.some(
      (entry) => entry.id === "antidrift/no-nullable-positional-tuple",
    ) ||
    !localAstRuleStatus.entries.some(
      (entry) => entry.id === "antidrift/no-raw-fetch-in-component",
    ) ||
    retiredRuleStatus.entries.map((entry) => entry.id).join(",") !==
      "antidrift/no-status-triplet-state" ||
    ecosystemCoveredRuleStatus.entries.map((entry) => entry.id).join(",") !==
      "ecosystem/import-cycle" ||
    reactStateSemanticSummary.summaries
      ?.map((summary) => summary.semanticAdapters[0]?.id)
      .join(",") !== "react-state" ||
    reactStateSemanticSummary.summaries?.[0]?.semanticFactContracts
      ?.map((entry) => entry.factKind)
      .join(",") !==
      "broadSetterCoMutation,resourceLifecycleProof,sourceMemberStateShardCandidate" ||
    !localAstSemanticSummary.summaries?.some(
      (summary) =>
        summary.entry.id === "antidrift/no-async-array-method" &&
        summary.semanticAdapters[0]?.id === "async-control-flow",
    ) ||
    !localAstSemanticSummary.summaries?.some(
      (summary) =>
        summary.entry.id === "antidrift/no-nullable-positional-tuple" &&
        summary.semanticAdapters[0]?.id === "tuple-shape",
    ) ||
    !localAstSemanticSummary.summaries?.some(
      (summary) =>
        summary.entry.id === "antidrift/no-raw-fetch-in-component" &&
        summary.proofBuckets?.join(",") === "local-ast-source-shape",
    )
  ) {
    fail(
      `rule-status filters should expose adapter/proof-bucket/status/semantic-summary slices, got: ${JSON.stringify({ typeOwnerRuleStatus, asyncControlRuleStatus, tupleShapeRuleStatus, authorityRuleStatus, localAstRuleStatus, retiredRuleStatus, ecosystemCoveredRuleStatus, reactStateSemanticSummary, localAstSemanticSummary })}`,
    );
  }

  console.log(
    "6/7  typechecking every public export under supported TS resolution modes ...",
  );
  run(
    "pnpm",
    ["exec", "tsc", "-p", "tsconfig.bundler.json", "--pretty", "false"],
    work,
  );
  run(
    "pnpm",
    ["exec", "tsc", "-p", "tsconfig.nodenext.json", "--pretty", "false"],
    work,
  );

  console.log("7/7  importing every public runtime export ...");
  run("node", ["packages/app/src/runtime.mjs"], work);

  console.log(
    `\n✓ tarball installs, type-checks, imports, and enforces in a consumer monorepo`,
  );
  console.log(
    `  focused governance rejected oversized root, Convex, script, fixture, test, and undeclared generated-looking modules while ignoring registry-declared generated code, declarations, and raw JSON; consumer precedence disabled max-lines, the default typed config loaded registry owners and fired ${RULE} on drift.ts, the inventory config checked a TypeScript 6 broad-input predicate, async-array shipped behavior matched default and opt-in branch expectations, a structuralMatch fact was emitted, and clean.ts/package-copy.ts stayed clean; public exports and semantic adapters passed Bundler and NodeNext.`,
  );
  rmSync(work, { recursive: true, force: true });
} catch (error) {
  console.error(error.stdout || error.stderr || error.message || error);
  fail("integration run threw");
}
