import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { collectTouchedModuleGraph } from "../src/change-scope/module-graph.mjs";
import { checkRegistries } from "../src/policy/check-registries.mjs";
import { dataFlowProbes } from "./headless-data-flow-probes.mjs";
import { typeContractProbes } from "./headless-type-contract-probes.mjs";

const abstractionProbes = [
  {
    name: "no-hypothetical-seam (implemented interface and abstract class with one production adapter reported)",
    rule: "antidrift/no-hypothetical-seam",
    file: "tooling/antidrift/src/__probe_seam_single.ts",
    source: `
      export interface Clock { now(): number }
      export class SystemClock implements Clock { now() { return Date.now(); } }
      export abstract class Store { abstract read(): string }
      export class MemoryStore extends Store { read() { return ""; } }
    `,
    expectedCount: 2,
  },
  {
    name: "no-hypothetical-seam (test adapter, two production adapters, and unimplemented data shape stay clean)",
    rule: "antidrift/no-hypothetical-seam",
    file: "tooling/antidrift/src/__probe_seam_multi.ts",
    source: `
      export interface Ticker { tick(): number }
      export class WallTicker implements Ticker { tick() { return Date.now(); } }
      export interface Sink { write(line: string): void }
      export class FileSink implements Sink { write(line: string) { void line; } }
      export class NetSink implements Sink { write(line: string) { void line; } }
      export interface Row { id: string }
    `,
    expectedCount: 0,
  },
  {
    name: "no-hypothetical-seam (effectful defaults only a test call site overrides reported)",
    rule: "antidrift/no-hypothetical-seam",
    file: "tooling/antidrift/src/__probe_seam_runner.ts",
    source: `
      import { execFileSync } from "node:child_process";
      export function runGit(args: string[], exec = execFileSync) {
        return exec("git", args);
      }
      export class Stamp {
        constructor(private readonly now = Date.now) {}
        at() { return this.now(); }
      }
      export function main() {
        runGit(["status"]);
        return new Stamp().at();
      }
    `,
    expectedCount: 2,
  },
  {
    name: "no-hypothetical-seam (production override and literal default stay clean)",
    rule: "antidrift/no-hypothetical-seam",
    file: "tooling/antidrift/src/__probe_seam_injected.ts",
    source: `
      import { execFileSync } from "node:child_process";
      export function runTool(args: string[], exec = execFileSync, retries = 3) {
        return exec("tool", args).length + retries;
      }
      export function dryRun() {
        return runTool(["--dry"], () => Buffer.from(""));
      }
    `,
    expectedCount: 0,
  },
  {
    name: "no-closed-string-parameter (includes/!== closed sets and bare-literal boolean mode flag reported)",
    rule: "antidrift/no-closed-string-parameter",
    file: "tooling/antidrift/src/__probe_closed_string.ts",
    source: `
      const MODES = ["fast", "slow"] as const;
      export function pickMode(mode: string) {
        if (!MODES.includes(mode as (typeof MODES)[number])) throw new Error(\`unknown mode \${mode}\`);
        return mode;
      }
      export function pickLevel(level: string) {
        if (level !== "info" && level !== "warn") throw new Error("unknown level");
        return level;
      }
      export function render(text: string, verbose: boolean) {
        if (verbose) return text.toUpperCase();
        return text;
      }
      export function main() { return render(pickMode("fast") + pickLevel("info"), true); }
    `,
    expectedCount: 3,
  },
  {
    name: "no-closed-string-parameter (unknown decoder, single literal, setter, stored flag, and variable flag argument stay clean)",
    rule: "antidrift/no-closed-string-parameter",
    file: "tooling/antidrift/src/__probe_closed_string_clean.ts",
    source: `
      export function decodeMode(mode: string, raw: unknown) {
        if (mode !== "a" && mode !== "b") throw new Error("bad mode");
        return raw;
      }
      export function requireA(mode: string) {
        if (mode !== "a") throw new Error("bad mode");
        return mode;
      }
      export function setEnabled(on: boolean) { return on ? 1 : 0; }
      export function stored(label: string, verbose: boolean) { const keep = verbose; return keep ? label : ""; }
      export function quiet(text: string, verbose: boolean) {
        if (verbose) return text;
        return "";
      }
      export function callers(flag: boolean) { setEnabled(true); stored("x", false); return quiet("x", flag); }
    `,
    expectedCount: 0,
  },
  {
    name: "no-argument-mutation-side-effect (void writers into type literal, interface, Map, and Record arguments reported)",
    rule: "antidrift/no-argument-mutation-side-effect",
    file: "tooling/antidrift/src/__probe_argument_mutation.ts",
    source: `
      type Options = { retries: number; label?: string };
      interface Row { id: string; seen: boolean }
      export function applyDefaults(options: Options): void {
        options.retries = 3;
      }
      export function markSeen(row: Row) {
        row.seen = true;
      }
      export const tally = (counts: Map<string, number>, key: string) => {
        counts.set(key, 1);
      };
      export function bump(totals: Record<string, number>, key: string) {
        totals[key]++;
      }
    `,
    expectedCount: 4,
  },
  {
    name: "no-argument-mutation-side-effect (returned copy, accumulator name, service interface, rebind, and middleware stay clean)",
    rule: "antidrift/no-argument-mutation-side-effect",
    file: "tooling/antidrift/src/__probe_argument_mutation_clean.ts",
    source: `
      type Options = { retries: number };
      interface Service { run(): void; count: number }
      export function withDefaults(options: Options) {
        return { ...options, retries: 3 };
      }
      export function fill(acc: Record<string, number>) {
        acc.total = 1;
      }
      export function tick(service: Service) {
        service.count = 1;
      }
      export function rebind(options: Options) {
        options = { ...options };
        options.retries = 1;
      }
      export function middleware(req: Options, res: Options, next: () => void) {
        req.retries = res.retries;
        next();
      }
    `,
    expectedCount: 0,
  },
];

export const headlessRuleProbes = [
  ...abstractionProbes,
  ...dataFlowProbes,
  ...typeContractProbes,
];

const OPTION_FAILURE_PROBES = [
  [
    { name: "antidrift/react-max-component-props", options: [{ max: 0 }] },
    /max must be >= 1/,
  ],
  [
    { name: "antidrift/no-compat-names", options: [{ files: ["["] }] },
    /invalid glob/,
  ],
  [
    { name: "antidrift/no-adhoc-loader", options: [{ owner: "" }] },
    /'owner' must be a non-empty string/,
  ],
  [
    {
      name: "antidrift/no-adhoc-loader",
      options: [{ allowedFiles: [{ path: "x.tsx", reason: "" }] }],
    },
    /'allowedFiles\[\]\.reason' must be a non-empty string/,
  ],
];

const GENERATED_HEADER_PROBES = [
  ['/** do not edit the retries default */\nexport { foo } from "./bar";\n', 1],
  ['/** @generated */\nexport { foo } from "./bar";\n', 0],
  ['"use client";\n// @generated\nexport { foo } from "./bar";\n', 0],
  ['#!/usr/bin/env node\r// @generated\rexport { foo } from "./bar";\n', 0],
  ['// license\u2028// @generated\u2028export { foo } from "./bar";\n', 0],
  ['\uFEFF// license\n\uFEFF// @generated\nexport { foo } from "./bar";\n', 0],
];

export function verifyHeaderAndOptionFailureProbes(
  runHeadlessProbe,
  probeFileA
) {
  const reexportRule = [{ name: "antidrift/no-reexport-only-module" }];
  for (const [source, expected] of GENERATED_HEADER_PROBES) {
    const diags = runHeadlessProbe({
      version: 2,
      configs: [{ file_paths: [probeFileA], rules: reexportRule }],
      source_overrides: { [probeFileA]: source },
    });
    assert.equal(diags.length, expected, JSON.stringify(diags));
  }
  for (const [rule, pattern] of OPTION_FAILURE_PROBES) {
    const payload = {
      version: 2,
      configs: [{ file_paths: [probeFileA], rules: [rule] }],
      source_overrides: { [probeFileA]: "export const x = 1;\n" },
    };
    assert.throws(() => runHeadlessProbe(payload), pattern);
  }
}

function inferredFindings(binaryPath, cwd, target) {
  const run = spawnSync(binaryPath, ["--format", "json", target], {
    cwd,
    encoding: "utf8",
  });
  return JSON.parse(String(run.stdout ?? "[]")).flatMap((entry) =>
    entry.messages.map((message) => `${message.line} ${message.ruleId}`)
  );
}

function verifyCliLevelsAndPaths(binaryPath, workspace) {
  const pkgA = join(workspace, "levels/packages/a");
  const pkgB = join(workspace, "levels/packages/b");
  mkdirSync(pkgA, { recursive: true });
  mkdirSync(pkgB, { recursive: true });
  const near = `${Array.from({ length: 450 }, (_, i) => `export const c${i} = ${i};`).join("\n")}\n`;
  writeFileSync(join(pkgA, "near.ts"), near);
  writeFileSync(join(pkgB, "cast.ts"), "export const legacyValue = 1;\n");
  const warnRun = spawnSync(binaryPath, ["--format", "json", "near.ts"], {
    cwd: pkgA,
    encoding: "utf8",
  });
  assert.equal(warnRun.status, 0);
  const denyRun = spawnSync(
    binaryPath,
    ["--format", "json", "--deny-warnings", "near.ts"],
    { cwd: pkgA, encoding: "utf8" }
  );
  assert.equal(denyRun.status, 1);
  const ruleWarn = spawnSync(
    binaryPath,
    [
      "--format",
      "json",
      "--rule",
      "antidrift/no-compat-names=warn",
      "../b/cast.ts",
      "../b/./cast.ts",
    ],
    { cwd: pkgA, encoding: "utf8" }
  );
  assert.equal(ruleWarn.status, 0);
  assert.deepEqual(
    JSON.parse(ruleWarn.stdout).map((e) => [e.filePath, e.warningCount]),
    [["../b/cast.ts", 1]]
  );
}

function verifyBrokenTsconfigFails(binaryPath, repoRoot, workspace) {
  verifyCliLevelsAndPaths(binaryPath, workspace);
  const brokenDir = join(workspace, "broken-tsconfig");
  mkdirSync(join(brokenDir, "src/deep"), { recursive: true });
  symlinkSync("src/deep", join(brokenDir, "link"));
  writeFileSync(join(brokenDir, "src/index.ts"), "export const x = 1;\n");
  writeFileSync(join(brokenDir, "index.ts"), "export const legacyValue = 1;\n");
  assert.deepEqual(
    inferredFindings(binaryPath, brokenDir, "link/../index.ts"),
    []
  );
  for (const [cfg, pattern] of [
    ["{ invalid json\n", /Invalid tsconfig/u],
    [
      '{ "compilerOptions": { "baseUrl": "." }, "include": ["src"] }\n',
      /baseUrl/u,
    ],
  ]) {
    writeFileSync(join(brokenDir, "tsconfig.json"), cfg);
    const run = spawnSync(binaryPath, ["src/index.ts"], {
      cwd: brokenDir,
      encoding: "utf8",
    });
    assert.notEqual(run.status, 0);
    assert.match(`${run.stdout}${run.stderr}`, pattern);
  }
  const graph = collectTouchedModuleGraph({
    cwd: repoRoot,
    head: "HEAD",
    tsconfig: "tsconfig.json",
    changedFiles: [
      {
        path: "tooling/antidrift/src/oxlint-config/index.mjs",
        operation: "modify",
      },
    ],
    allowedEntrypoints: ["tooling/antidrift/src/index.mjs"],
    maxTouchedModuleRadius: 2,
  });
  assert.deepEqual(graph.entrypoints, ["tooling/antidrift/src/index.mjs"]);
  assert.equal(graph.touchedFiles[0]?.withinRadius, true);
}

function verifyRegistryAndRoleSmokes(binaryPath, repoRoot, workspace) {
  const regDir = join(workspace, "reg-smoke/policy/registries");
  mkdirSync(regDir, { recursive: true });
  writeFileSync(join(regDir, "mcp.yaml"), "allowedServers: {}\n");
  writeFileSync(
    join(workspace, "reg-smoke/policy/agent-guardrails.yaml"),
    "clusters:\n  - id: c\n    owner: o\n    rules:\n      - id: r\n        detector: fictionalDetector\n      - id: cross\n        detector: oxlint:boundaries/element-types\n"
  );
  const regErrors = [];
  const ok = checkRegistries({
    repoRoot,
    policyDir: join(workspace, "reg-smoke/policy"),
    report: (msg) => regErrors.push(msg),
  });
  assert.equal(ok, false);
  assert.deepEqual(regErrors, [
    "policy/registries/mcp.yaml has no registered reader (allowed: architecture, boundaries, domain, gateways, generated, react-native).",
    "policy/agent-guardrails.yaml rule 'r' detector 'fictionalDetector' is not registered.",
    "policy/agent-guardrails.yaml rule 'cross' detector 'oxlint:boundaries/element-types' is not registered.",
  ]);
  const roleRepo = join(workspace, "role-smoke");
  for (const sub of ["policy/registries", "core/models", "build"])
    mkdirSync(join(roleRepo, sub), { recursive: true });
  writeFileSync(
    join(roleRepo, "policy/registries/architecture.yaml"),
    "layers:\n  models:\n    role: domain\n    roots:\n      - core/models/**\n    mayImport: []\n"
  );
  writeFileSync(
    join(roleRepo, "tsconfig.json"),
    '{ "compilerOptions": { "strict": true, "target": "es2022", "module": "esnext", "moduleResolution": "bundler" }, "include": ["core", "build"] }\n'
  );
  const shape =
    "{ id: string; orgId: string; status: string; createdAt: number; updatedAt: number }";
  writeFileSync(
    join(roleRepo, "core/models/account.ts"),
    `export type Account = ${shape};\n`
  );
  writeFileSync(
    join(roleRepo, "build/reexport.ts"),
    'export { type Account } from "../core/models/account.js";\n'
  );
  writeFileSync(
    join(roleRepo, "build/fork.ts"),
    `export type DupAccount = ${shape};\n`
  );
  assert.deepEqual(inferredFindings(binaryPath, roleRepo, "build"), [
    "1 antidrift/no-structural-type-fork",
    "1 antidrift/no-reexport-only-module",
  ]);
}

export function proveInferredTypesSmoke(binaryPath, repoRoot) {
  const workspace = mkdtempSync(join(tmpdir(), "antidrift-inferred-types-"));
  try {
    const monorepoDir = join(workspace, "monorepo");
    const appDir = join(monorepoDir, "packages/app");
    mkdirSync(join(appDir, "node_modules/@types"), { recursive: true });
    mkdirSync(join(appDir, "scripts"), { recursive: true });
    symlinkSync(
      realpathSync(resolve(repoRoot, "node_modules/@types/node")),
      join(appDir, "node_modules/@types/node"),
      "junction"
    );
    const pkg =
      '{ "name": "probe", "version": "0.0.0", "type": "module", "private": true }\n';
    writeFileSync(join(monorepoDir, "package.json"), pkg);
    writeFileSync(join(appDir, "package.json"), pkg);
    writeFileSync(
      join(appDir, "scripts/probe.mjs"),
      'import { readFileSync } from "node:fs";\nconst fromDisk = JSON.parse(readFileSync("x.json", "utf8"));\nconst fromNowhere = JSON.parse(globalThis.untypedThing);\nconsole.log(fromDisk, fromNowhere);\n'
    );
    assert.deepEqual(
      inferredFindings(
        binaryPath,
        monorepoDir,
        "packages/app/scripts/probe.mjs"
      ),
      ["3 antidrift/no-unsafe-deserialize"]
    );
    assert.deepEqual(
      inferredFindings(binaryPath, appDir, "scripts/probe.mjs"),
      ["3 antidrift/no-unsafe-deserialize"]
    );
    verifyBrokenTsconfigFails(binaryPath, repoRoot, workspace);
    verifyRegistryAndRoleSmokes(binaryPath, repoRoot, workspace);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}
