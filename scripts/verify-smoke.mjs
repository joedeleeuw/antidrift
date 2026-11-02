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

const badSource = `
import { useSyncExternalStore } from "react";
import { TouchableOpacity } from "react-native";
import { Text as WidgetText } from "@expo/ui/swift-ui";
import { z } from "zod";

type HiddenUnknown = unknown;
export const ORDER_MODES = ["fast", "slow"] as const;
export type OrderMode = "fast" | "slow";

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

const outerGreeting = "Hello";

export function BrokenWidget() {
  "widget";
  return <WidgetText>{outerGreeting}</WidgetText>;
}

function getUnstableSnapshot() {
  return { now: 1 };
}

export function LegacyTouchableView({ subscribe }: { subscribe: () => () => void }) {
  const snap = useSyncExternalStore(subscribe, getUnstableSnapshot);
  return <TouchableOpacity>{snap.now}</TouchableOpacity>;
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
  const erasedKnown = { id: "known" } as unknown;
  const parsed = z.object({ id: z.string() }).parse(erasedKnown);
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

declare const ipcMain: {
  handle: (channel: string, handler: (event: { sender: unknown; senderFrame: unknown }, url: string) => void) => void;
};
declare const shell: { openExternal: (url: string) => void };
ipcMain.handle("open-url", (_event, url) => {
  shell.openExternal(url);
});

export function badActivityReducer(
  state: { submitting: boolean; resending: boolean; googleSubmitting: boolean },
  action: { type: string }
) {
  switch (action.type) {
    case "submit":
      return { ...state, submitting: true, resending: false, googleSubmitting: false };
    case "resend":
      return { ...state, submitting: false, resending: true, googleSubmitting: false };
    default:
      return state;
  }
}
`;

const goodSource = `
import { useSyncExternalStore } from "react";
import { Text } from "@expo/ui/swift-ui";
import { z } from "zod";

export interface OrderSummary {
  readonly orderId: string;
  readonly totalCents: number;
}

export function formatOrderSummary(summary: OrderSummary): string {
  return \`\${summary.orderId}: \${summary.totalCents}\`;
}

export function CleanWidget(props: {
  a: string;
  b: string;
  c: string;
  d: string;
  e: string;
  f: string;
  g: string;
  h: string;
}) {
  "widget";
  const label = props.a;
  return <Text>{label}</Text>;
}

declare const ipcMain: {
  handle: (channel: string, handler: (event: { sender: unknown; senderFrame: unknown }, url: string) => void) => void;
};
declare const shell: { openExternal: (url: string) => void };
declare function isTrustedSender(sender: unknown): boolean;
ipcMain.handle("open-url-safe", (event, url) => {
  if (!isTrustedSender(event.sender)) {
    throw new Error("Untrusted sender");
  }
  shell.openExternal(url);
});
ipcMain.handle("open-url-positive", (event, url) => {
  if (isTrustedSender(event.sender)) {
    return shell.openExternal(url);
  }
});

const cachedSnapshot = { ready: true };
function getStableSnapshot() {
  return Object.assign(cachedSnapshot, { ready: true });
}

export function useReadySnapshot(subscribe: () => () => void) {
  return useSyncExternalStore(subscribe, getStableSnapshot);
}

const InputSchema = z.object({ id: z.string(), secret: z.string() });
const PublicSchema = z.object({ id: z.string() });
export const ProjectedSchema = InputSchema.transform((row) => ({
  id: row.id,
  redacted: true,
}));

export function parseTwoStage(raw: unknown) {
  const first = InputSchema.parse(raw);
  return PublicSchema.parse(first);
}

export function decodeBoundaryJson(rawText: string) {
  const boundaryRaw: unknown = JSON.parse(rawText);
  return PublicSchema.parse(boundaryRaw);
}
`;

const expectedRules = [
  "antidrift/no-unknown-type-aliases",
  "antidrift/no-redeclared-owned-union",
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
  "antidrift/no-unbound-widget-capture",
  "antidrift/no-raw-react-native-touchables",
  "antidrift/require-stable-snapshot",
  "antidrift/require-authz-check",
  "antidrift/no-handrolled-resource-lifecycle-cells",
  "antidrift/no-appeasement-erasure",
];

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
