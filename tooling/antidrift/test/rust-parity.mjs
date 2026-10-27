import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createMemoryFactSink,
  emitSemanticFact,
} from "../src/policy/lib/semantic-facts.mjs";
import { portableCases } from "./portable-cases.mjs";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "../../..");
const binaryPath = resolve(repoRoot, "target/debug/antidrift-linter");

execFileSync("cargo", ["build", "--bin", "antidrift-linter", "--quiet"], {
  cwd: repoRoot,
  stdio: "inherit",
});

const registeredRulesOutput = execFileSync(binaryPath, ["--list-rules"], {
  cwd: repoRoot,
  encoding: "utf8",
});
const registeredRules = new Set(
  registeredRulesOutput
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
);

const batchInputs = [];
const expectations = new Map();

for (const entry of portableCases) {
  const fullRuleId = `antidrift/${entry.name}`;
  if (!registeredRules.has(fullRuleId)) {
    continue;
  }
  const invalidId = `${entry.name}:invalid`;
  const validId = `${entry.name}:valid`;
  const invalidFilename = entry.filename ?? "component.tsx";
  const validFilename =
    entry.validFilename ?? entry.filename ?? "component.tsx";

  batchInputs.push({
    id: invalidId,
    filename: invalidFilename,
    sourceText: entry.invalid,
    rule: fullRuleId,
    options: entry.options ?? null,
  });
  expectations.set(invalidId, {
    ruleId: fullRuleId,
    expectedCount: entry.occurrences ?? 1,
  });

  batchInputs.push({
    id: validId,
    filename: validFilename,
    sourceText: entry.valid,
    rule: fullRuleId,
    options: entry.validOptions ?? entry.options ?? null,
  });
  expectations.set(validId, {
    ruleId: fullRuleId,
    expectedCount: 0,
  });
}

batchInputs.push({
  id: "inline-directive:suppressed",
  filename: "suppressed.ts",
  sourceText:
    "// eslint-disable-next-line antidrift/no-as-never\nconst x = 1 as never;\n",
  rule: "antidrift/no-as-never",
  reportUnusedDirectives: true,
});
expectations.set("inline-directive:suppressed", {
  ruleId: "antidrift/no-as-never",
  expectedCount: 0,
});

batchInputs.push({
  id: "inline-directive:unused",
  filename: "unused.ts",
  sourceText:
    "// oxlint-disable-next-line antidrift/no-as-never\nconst x = 1;\n",
  rule: "antidrift/no-as-never",
  reportUnusedDirectives: true,
});
expectations.set("inline-directive:unused", {
  ruleId: "unused-disable-directive",
  expectedCount: 1,
});

const factSourceText = "export const schema = z.object({ id: z.string() });\n";
const factPayload = {
  diagnostic: true,
  inputShape: null,
  outputShape: null,
  transform: "identity",
};
batchInputs.push({
  id: "semantic-fact:hash-parity",
  filename: "packages/domain/schema.ts",
  sourceText: factSourceText,
  factProbe: {
    start: 13,
    end: 50,
    factKind: "identitySchemaTransform",
    ruleId: "antidrift/no-identity-schema-transform",
    adapterId: "typescript-eslint/schema-provenance",
    confidence: "deterministic-enforcement",
    provenance: ["TypeChecker", "AST"],
    payload: factPayload,
  },
});
expectations.set("semantic-fact:hash-parity", {
  ruleId: "antidrift/no-identity-schema-transform",
  expectedCount: 0,
});

const rawBatchOutput = execFileSync(binaryPath, ["--batch-json", "-"], {
  cwd: repoRoot,
  input: JSON.stringify(batchInputs),
  encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024,
});

const batchResults = JSON.parse(rawBatchOutput);
assert.equal(batchResults.length, batchInputs.length);

for (const outcome of batchResults) {
  const expected = expectations.get(outcome.id);
  assert.ok(expected, `Missing expectation for ${outcome.id}`);
  assert.equal(
    outcome.diagnostics.length,
    expected.expectedCount,
    `Case ${outcome.id} expected ${expected.expectedCount} diagnostics, got ${JSON.stringify(outcome.diagnostics)}`
  );
  for (const diag of outcome.diagnostics) {
    assert.equal(diag.ruleId, expected.ruleId);
  }
  if (outcome.id === "semantic-fact:hash-parity") {
    const memorySink = createMemoryFactSink();
    emitSemanticFact(
      {
        filename: "packages/domain/schema.ts",
        sourceCode: { text: factSourceText },
        settings: { antidrift: { semanticFacts: memorySink } },
      },
      {
        loc: {
          start: { line: 1, column: 13 },
          end: { line: 1, column: 50 },
        },
      },
      {
        factKind: "identitySchemaTransform",
        ruleId: "antidrift/no-identity-schema-transform",
        adapterId: "typescript-eslint/schema-provenance",
        confidence: "deterministic-enforcement",
        provenance: ["TypeChecker", "AST"],
        payload: factPayload,
      }
    );
    assert.equal(outcome.facts.length, 1);
    assert.deepEqual(outcome.facts[0], memorySink.facts[0]);
  }
}

console.log(
  `✓ antidrift-linter Rust parity verified (${registeredRules.size} rules registered, ${batchResults.length} batch cases + SemanticFact hash parity passed)`
);
