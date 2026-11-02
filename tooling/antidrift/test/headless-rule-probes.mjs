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
        if (!MODES.includes(mode as (typeof MODES)[number])) {
          throw new Error(\`unknown mode \${mode}\`);
        }
        return mode;
      }
      export function pickLevel(level: string) {
        if (level !== "info" && level !== "warn") {
          throw new Error("unknown level");
        }
        return level;
      }
      export function render(text: string, verbose: boolean) {
        if (verbose) {
          return text.toUpperCase();
        }
        return text;
      }
      export function main() {
        return render(pickMode("fast") + pickLevel("info"), true);
      }
    `,
    expectedCount: 3,
  },
  {
    name: "no-closed-string-parameter (unknown decoder, single literal, setter, stored flag, and variable flag argument stay clean)",
    rule: "antidrift/no-closed-string-parameter",
    file: "tooling/antidrift/src/__probe_closed_string_clean.ts",
    source: `
      export function decodeMode(mode: string, raw: unknown) {
        if (mode !== "a" && mode !== "b") {
          throw new Error("bad mode");
        }
        return raw;
      }
      export function requireA(mode: string) {
        if (mode !== "a") {
          throw new Error("bad mode");
        }
        return mode;
      }
      export function setEnabled(on: boolean) {
        return on ? 1 : 0;
      }
      export function stored(label: string, verbose: boolean) {
        const keep = verbose;
        return keep ? label : "";
      }
      export function quiet(text: string, verbose: boolean) {
        if (verbose) {
          return text;
        }
        return "";
      }
      export function callers(flag: boolean) {
        setEnabled(true);
        stored("x", false);
        return quiet("x", flag);
      }
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
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}
