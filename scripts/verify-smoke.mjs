import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import tsParser from "@typescript-eslint/parser";
import { ESLint } from "eslint";

import {
  antidriftPlugin,
  createEslintConfig,
  createOxlintConfig,
  eslintPreset,
  oxlintPreset,
  recommendedRules,
  rules,
} from "../src/index.js";

const repoRoot = resolve(import.meta.dirname, "..");

assert.equal(antidriftPlugin.meta.name, "antidrift");
const ruleNames = Object.keys(rules);
assert.ok(
  ruleNames.length >= 100,
  `Expected >= 100 rules, got ${ruleNames.length}`
);

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
}

assert.deepEqual(oxlintPreset.jsPlugins, ["@joedeleeuw/antidrift"]);
assert.equal(eslintPreset.plugins.antidrift, antidriftPlugin);

const badSource = `
import { z } from "zod";

type HiddenUnknown = unknown;

interface FirstContract {
  id: string;
  title: string;
  count: number;
}

interface DuplicateContract {
  id: string;
  title: string;
  count: number;
}

export function processLegacyData(
  items: number[],
  mode: string,
  rawJson: string,
  payload: unknown
) {
  let chosen: number;
  if (mode === "fast") {
    chosen = 1;
    return JSON.parse(rawJson) as FirstContract;
  } else if (mode === "slow") {
    chosen = 2;
    return (payload as unknown as FirstContract).title;
  } else if (mode === "medium") {
    chosen = 3;
  } else if (mode === "turbo") {
    chosen = 4;
  }
  const parsed = z.object({ id: z.string() }).parse(payload);
  return [chosen, z.object({ id: z.string() }).parse(parsed)];
}

export async function runInParallel(urls: string[]) {
  urls.forEach(async (url) => {
    await fetch(url);
  });
}

export function BadComponent({ items = [] }: { items?: string[] }) {
  const randomId = Math.random();
  return <div>{randomId}{items.length}</div>;
}
`;

const goodSource = `
export interface OrderSummary {
  readonly orderId: string;
  readonly totalCents: number;
}

export function formatOrderSummary(summary: OrderSummary): string {
  return \`\${summary.orderId}: \${summary.totalCents}\`;
}
`;

const expectedRules = [
  "antidrift/no-unknown-type-aliases",
  "antidrift/no-structural-type-fork",
  "antidrift/no-compat-names",
  "antidrift/no-closed-string-parameter",
  "antidrift/no-mutable-let-alias",
  "antidrift/no-else-if-chain",
  "antidrift/no-unsafe-deserialize",
  "antidrift/no-unsafe-cast-chain",
  "antidrift/no-redundant-zod-parse",
  "antidrift/no-async-array-method",
  "antidrift/no-unstable-render-default-collection",
  "antidrift/no-impure-render-call",
];

const workDir = mkdtempSync(join(tmpdir(), "antidrift-smoke-"));
try {
  const badFile = join(workDir, "bad.tsx");
  const goodFile = join(workDir, "good.ts");
  const oxlintConfigFile = join(workDir, "oxlint.config.json");

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
  const oxlintCodes = new Set(oxlintDiagnostics.map((d) => d.code));
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
  const eslintRuleIds = new Set(eslintBad.messages.map((m) => m.ruleId));
  for (const expected of expectedRules) {
    assert.ok(
      eslintRuleIds.has(expected),
      `Expected ESLint to report ${expected}, got: ${[...eslintRuleIds].join(", ")}`
    );
  }

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

  console.log(
    `Smoke passed: ${ruleNames.length} host-agnostic rules verified in Oxlint, ESLint, and packed tarball.`
  );
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
