import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addedDependencies, changedFilesBetween, collectChangeSurface, mergeBase } from "./change-context.mjs";

const BASE = "HEAD~1";
const HEAD = "HEAD";
const PKG = "package.json";
const SRC_FILE = "src/a.ts";
const DOC_FILE = "docs.md";
const SHA_PATTERN = /^[\da-f]{7,}$/u;

let dir;

function runGit(args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

function writeJson(path, value) {
  writeFileSync(join(dir, path), `${JSON.stringify(value, null, 2)}\n`);
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "change-context-"));
  runGit(["init", "-q", "-b", "main"]);
  runGit(["config", "user.email", "test@example.com"]);
  runGit(["config", "user.name", "Test"]);
  runGit(["config", "commit.gpgsign", "false"]);
  runGit(["config", "core.hooksPath", "/dev/null"]);

  mkdirSync(join(dir, "src"), { recursive: true });
  writeJson(PKG, { name: "x", dependencies: { left: "1.0.0" } });
  writeFileSync(join(dir, SRC_FILE), "export const a = 1;\n");
  runGit(["add", "."]);
  runGit(["commit", "-q", "-m", "base"]);

  writeJson(PKG, { name: "x", dependencies: { left: "1.0.0", right: "2.0.0" } });
  writeFileSync(join(dir, SRC_FILE), "export const a = 2;\n");
  writeFileSync(join(dir, DOC_FILE), "# docs\n");
  runGit(["add", "."]);
  runGit(["commit", "-q", "-m", "head"]);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("change-context", () => {
  it("resolves a merge-base sha", () => {
    expect(mergeBase({ base: BASE, head: HEAD, cwd: dir })).toMatch(SHA_PATTERN);
  });

  it("lists changed files with operations", () => {
    const files = changedFilesBetween({ base: BASE, head: HEAD, cwd: dir });
    const operationByPath = Object.fromEntries(files.map((file) => [file.path, file.operation]));
    expect(operationByPath[SRC_FILE]).toBe("modify");
    expect(operationByPath[DOC_FILE]).toBe("add");
    expect(operationByPath[PKG]).toBe("modify");
  });

  it("detects an added runtime dependency without flagging existing ones", () => {
    const changedFiles = changedFilesBetween({ base: BASE, head: HEAD, cwd: dir });
    const { runtime, dev } = addedDependencies({ base: BASE, head: HEAD, cwd: dir, changedFiles });
    expect(runtime).toContain("right");
    expect(runtime).not.toContain("left");
    expect(dev).toEqual([]);
  });

  it("collects the full change surface from the merge-base", () => {
    const surface = collectChangeSurface({ base: BASE, head: HEAD, cwd: dir });
    expect(surface.changedFiles).toHaveLength(3);
    expect(surface.addedRuntimeDependencies).toContain("right");
    expect(surface.mergeBase).toMatch(SHA_PATTERN);
  });
});
