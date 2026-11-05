import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import tsParser from "@typescript-eslint/parser";
import { ESLint } from "eslint";

import {
  antidriftPlugin,
  astOnlyPreset,
  astOnlyRules,
  createEslintConfig,
  createOxlintConfig,
  eslintPreset,
  eslintTypedPreset,
  oxlintPreset,
  recommendedRules,
  rules,
  typedRuleNames,
  typedRules,
} from "../src/index.js";
import { runPackedConsumerSmoke } from "./packed-consumer-smoke.mjs";
import {
  badSource,
  expectedDiagnostics,
  expectedRules,
  goodSource,
} from "./smoke-fixtures.mjs";
import { runTypedEslintSmoke } from "./typed-eslint-smoke.mjs";
import { runVagueNamesSmoke } from "./vague-names-smoke.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const expectedRuleCount = 83;

assert.equal(antidriftPlugin.meta.name, "antidrift");
const ruleNames = Object.keys(rules);
assert.equal(
  ruleNames.length,
  expectedRuleCount,
  `Expected ${expectedRuleCount} rules, got ${ruleNames.length}`
);
assert.equal(Object.keys(recommendedRules).length, expectedRuleCount);
assert.equal(typedRuleNames.length, 21);
assert.equal(Object.keys(typedRules).length, 21);
assert.equal(Object.keys(astOnlyRules).length, 62);
assert.equal(
  Object.keys(typedRules).length + Object.keys(astOnlyRules).length,
  expectedRuleCount
);
assert.equal(eslintTypedPreset.name, "antidrift/typed");
assert.deepEqual(eslintTypedPreset.rules, typedRules);
assert.deepEqual(astOnlyPreset.rules, astOnlyRules);

for (const [name, rule] of Object.entries(rules)) {
  assert.equal(
    typeof rule?.create,
    "function",
    `Rule ${name} must expose create(context)`
  );
  assert.equal(
    recommendedRules[`antidrift/${name}`],
    "error",
    `Preset must enable antidrift/${name}`
  );
  assert.ok(
    rule.meta?.schema?.[0]?.properties?.files,
    `Rule ${name} must accept 'files' in meta.schema`
  );
  assert.ok(
    rule.meta?.schema?.[0]?.properties?.excludeFiles,
    `Rule ${name} must accept 'excludeFiles' in meta.schema`
  );
}

assert.deepEqual(oxlintPreset.jsPlugins, ["@joedeleeuw/antidrift"]);
assert.equal(eslintPreset.plugins.antidrift, antidriftPlugin);

const workDir = mkdtempSync(join(tmpdir(), "antidrift-smoke-"));
try {
  const badFile = join(workDir, "bad.tsx");
  const goodFile = join(workDir, "good.tsx");
  const pkgJsonFile = join(workDir, "package.json");
  const oxlintConfigFile = join(workDir, "oxlint.config.json");

  writeFileSync(
    pkgJsonFile,
    JSON.stringify({
      name: "smoke-fixture",
      private: true,
      dependencies: {
        "@expo/ui": "1.0.0",
        "@tauri-apps/api": "2.0.0",
        react: "19.0.0",
        "react-native": "0.78.0",
        zod: "4.0.0",
      },
    }),
    "utf8"
  );
  writeFileSync(badFile, badSource, "utf8");
  writeFileSync(goodFile, goodSource, "utf8");
  writeFileSync(
    oxlintConfigFile,
    JSON.stringify(
      createOxlintConfig({
        pluginSpecifier: resolve(repoRoot, "src/oxlint-plugin/index.js"),
      }),
      null,
      2
    ),
    "utf8"
  );

  const oxlintBin = resolve(repoRoot, "node_modules/.bin/oxlint");

  const goodOut = execFileSync(
    oxlintBin,
    ["-c", oxlintConfigFile, "--format", "json", goodFile],
    { encoding: "utf8" }
  );
  const goodDiagnostics = JSON.parse(goodOut).diagnostics ?? [];
  assert.equal(
    goodDiagnostics.length,
    0,
    `Expected 0 oxlint diagnostics on good.ts, got: ${JSON.stringify(goodDiagnostics)}`
  );

  let badOut = "";
  try {
    badOut = execFileSync(
      oxlintBin,
      ["-c", oxlintConfigFile, "--format", "json", badFile],
      { encoding: "utf8" }
    );
  } catch (error) {
    badOut = String(error.stdout ?? "");
  }
  const oxlintDiagnostics = JSON.parse(badOut).diagnostics ?? [];
  assert.ok(
    oxlintDiagnostics.every(
      (diagnostic) =>
        typeof diagnostic.code === "string" && diagnostic.code.length > 0
    ),
    `Expected all Oxlint diagnostics to carry a rule code, got: ${JSON.stringify(oxlintDiagnostics.filter((diagnostic) => !diagnostic.code))}`
  );
  const oxlintCodes = new Set(
    oxlintDiagnostics.map((diagnostic) => diagnostic.code)
  );
  for (const expected of expectedRules) {
    const ruleSlug = expected.split("/")[1];
    const matched = [...oxlintCodes].some(
      (code) => code === expected || code === `antidrift(${ruleSlug})`
    );
    assert.ok(
      matched,
      `Expected Oxlint to report ${expected}, got codes: ${[...oxlintCodes].join(", ")}`
    );
  }
  for (const { ruleId, message } of expectedDiagnostics) {
    const ruleSlug = ruleId.split("/")[1];
    assert.ok(
      oxlintDiagnostics.some(
        (diagnostic) =>
          (diagnostic.code === ruleId ||
            diagnostic.code === `antidrift(${ruleSlug})`) &&
          diagnostic.message === message
      ),
      `Expected Oxlint ${ruleId}: ${message}`
    );
  }

  const eslint = new ESLint({
    cwd: workDir,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ["**/*.{ts,tsx}"],
        languageOptions: {
          parser: tsParser,
          parserOptions: {
            ecmaFeatures: { jsx: true },
          },
        },
      },
      createEslintConfig({
        files: ["**/*.{ts,tsx}"],
      }),
    ],
  });

  const [eslintGood] = await eslint.lintFiles([goodFile]);
  assert.equal(
    eslintGood.messages.length,
    0,
    `Expected 0 ESLint diagnostics on good.ts, got: ${JSON.stringify(eslintGood.messages)}`
  );

  const [eslintBad] = await eslint.lintFiles([badFile]);
  const eslintRuleIds = new Set(
    eslintBad.messages.map((message) => message.ruleId)
  );
  for (const expected of expectedRules) {
    assert.ok(
      eslintRuleIds.has(expected),
      `Expected ESLint to report ${expected}, got: ${[...eslintRuleIds].join(", ")}`
    );
  }
  for (const { ruleId, message } of expectedDiagnostics) {
    assert.ok(
      eslintBad.messages.some(
        (diagnostic) =>
          diagnostic.ruleId === ruleId && diagnostic.message === message
      ),
      `Expected ESLint ${ruleId}: ${message}`
    );
  }

  await runVagueNamesSmoke({ workDir, oxlintBin, oxlintConfigFile, eslint });

  await runTypedEslintSmoke({
    workDir,
    repoRoot,
    goodFile,
    badFile,
    expectedRules,
    expectedDiagnostics,
  });

  const packOut = execFileSync(
    "pnpm",
    ["pack", "--pack-destination", workDir],
    { cwd: repoRoot, encoding: "utf8" }
  )
    .trim()
    .split("\n")
    .at(-1);
  assert.ok(
    packOut && packOut.endsWith(".tgz"),
    `Unexpected pack output: ${packOut}`
  );
  await runPackedConsumerSmoke({
    tarballPath: resolve(workDir, packOut),
    workDir,
    repoRoot,
    goodFile,
    badFile,
    expectedRuleCount,
    expectedRules,
  });

  process.stdout.write(
    `Smoke passed: ${ruleNames.length} host-agnostic rules verified in Oxlint, ESLint, typed ESLint, and independent packed-tarball consumer.\n`
  );
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
