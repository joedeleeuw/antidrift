import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { VIOLATION_TYPES } from "./analyze.mjs";
import {
  CHANGE_CONTRACT_CLAIM,
  parseArgs,
  runChangeContract,
} from "./change-contract.mjs";

const BASE = "HEAD~1";
const HEAD = "HEAD";
const CONTRACT_PATH = ".antidrift/change-contract.yaml";

let dir;

function runGit(args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

function writeJson(path, value) {
  writeFileSync(join(dir, path), `${JSON.stringify(value, null, 2)}\n`);
}

function writeContract(lines) {
  mkdirSync(join(dir, ".antidrift"), { recursive: true });
  writeFileSync(join(dir, CONTRACT_PATH), lines.join("\n"));
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "change-contract-"));
  runGit(["init", "-q", "-b", "main"]);
  runGit(["config", "user.email", "test@example.com"]);
  runGit(["config", "user.name", "Test"]);
  runGit(["config", "commit.gpgsign", "false"]);
  runGit(["config", "core.hooksPath", "/dev/null"]);

  mkdirSync(join(dir, "apps/orders"), { recursive: true });
  writeFileSync(join(dir, "apps/orders/format.ts"), "export const f = 1;\n");
  writeJson("package.json", { name: "x", dependencies: { left: "1.0.0" } });
  runGit(["add", "."]);
  runGit(["commit", "-q", "-m", "base"]);

  writeFileSync(join(dir, "apps/orders/format.ts"), "export const f = 2;\n");
  mkdirSync(join(dir, "apps/billing"), { recursive: true });
  writeFileSync(join(dir, "apps/billing/tax.ts"), "export const t = 1;\n");
  writeJson("package.json", { name: "x", dependencies: { left: "1.0.0", "@copilotkit/react-core": "1.0.0" } });
  runGit(["add", "."]);
  runGit(["commit", "-q", "-m", "fix orders"]);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("runChangeContract", () => {
  it("is inventory-only with no violations when the contract is missing", () => {
    const result = runChangeContract({ contractPath: "nope.yaml", base: BASE, head: HEAD, cwd: dir });
    expect(result.contractState).toBe("missing");
    expect(result.violations).toEqual([]);
    expect(result.decision).toBe("inventory");
  });

  it("throws when a contract is required but missing", () => {
    expect(() =>
      runChangeContract({ contractPath: "nope.yaml", base: BASE, head: HEAD, cwd: dir, requireContract: true }),
    ).toThrow(/not found/u);
  });

  it("flags an out-of-scope path and an undeclared runtime dependency", () => {
    writeContract(["schemaVersion: 1", "contractId: ORDERS-1", "scope:", "  allowedPaths:", "    - apps/orders/**", "  allowedRuntimeDependencies: []"]);
    const result = runChangeContract({ contractPath: CONTRACT_PATH, base: BASE, head: HEAD, cwd: dir });
    const types = result.violations.map((violation) => violation.type);
    expect(types).toContain(VIOLATION_TYPES.pathOutOfScope);
    expect(types).toContain(VIOLATION_TYPES.undeclaredRuntimeDependency);
    expect(result.claim).toBe(CHANGE_CONTRACT_CLAIM);
  });

  it("stays clean when the contract authorizes the full surface", () => {
    writeContract([
      "schemaVersion: 1",
      "contractId: ORDERS-2",
      "scope:",
      "  allowedPaths:",
      "    - apps/**",
      "    - package.json",
      "  allowedRuntimeDependencies:",
      "    - '@copilotkit/react-core'",
    ]);
    const result = runChangeContract({ contractPath: CONTRACT_PATH, base: BASE, head: HEAD, cwd: dir });
    expect(result.violations).toEqual([]);
  });
});

describe("change-contract CLI", () => {
  it("parses flags with inventory defaults", () => {
    const parsed = parseArgs(["--contract", "c.yaml", "--base", "main", "--require-contract"]);
    expect(parsed.contractPath).toBe("c.yaml");
    expect(parsed.base).toBe("main");
    expect(parsed.requireContract).toBe(true);
    expect(parsed.head).toBe("HEAD");
    expect(parsed.mode).toBe("inventory");
  });

  it("rejects an unknown flag", () => {
    expect(() => parseArgs(["--bogus"])).toThrow(/unknown argument/u);
  });

  it("rejects a value flag that swallows the next flag", () => {
    expect(() => parseArgs(["--contract", "--base", "main"])).toThrow(/requires a value/u);
  });

  it("requires a base ref when a contract is present", () => {
    writeContract(["schemaVersion: 1", "contractId: B-1", "scope:", "  allowedPaths:", "    - apps/**"]);
    expect(() => runChangeContract({ contractPath: CONTRACT_PATH, base: null, head: HEAD, cwd: dir })).toThrow(
      /base ref is required/u,
    );
  });
});
