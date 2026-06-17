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
  writeJson(PKG, { name: "x", dependencies: { left: "1.0.0" }, devDependencies: { mover: "1.0.0" } });
  writeFileSync(join(dir, SRC_FILE), "export const a = 1;\n");
  writeFileSync(join(dir, "src/old.ts"), "export const moved = 1;\n");
  runGit(["add", "-A"]);
  runGit(["commit", "-q", "-m", "base"]);

  writeJson(PKG, { name: "x", dependencies: { left: "1.0.0", right: "2.0.0", mover: "1.0.0" } });
  writeFileSync(join(dir, SRC_FILE), "export const a = 2;\n");
  writeFileSync(join(dir, DOC_FILE), "# docs\n");
  rmSync(join(dir, "src/old.ts"));
  writeFileSync(join(dir, "src/renamed.ts"), "export const moved = 1;\n");
  runGit(["add", "-A"]);
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
    expect(operationByPath["src/renamed.ts"]).toBe("rename");
  });

  it("tracks the old path of a rename", () => {
    const rename = changedFilesBetween({ base: BASE, head: HEAD, cwd: dir }).find((file) => file.operation === "rename");
    expect(rename.oldPath).toBe("src/old.ts");
    expect(rename.path).toBe("src/renamed.ts");
  });

  it("detects an added runtime dependency without flagging existing ones", () => {
    const changedFiles = changedFilesBetween({ base: BASE, head: HEAD, cwd: dir });
    const { runtime, dev } = addedDependencies({ base: BASE, head: HEAD, cwd: dir, changedFiles });
    expect(runtime).toContain("right");
    expect(runtime).not.toContain("left");
    expect(dev).toEqual([]);
  });

  it("treats a dev-to-runtime dependency move as a runtime addition", () => {
    const changedFiles = changedFilesBetween({ base: BASE, head: HEAD, cwd: dir });
    const { runtime } = addedDependencies({ base: BASE, head: HEAD, cwd: dir, changedFiles });
    expect(runtime).toContain("mover");
  });

  it("collects the full change surface from the merge-base", () => {
    const surface = collectChangeSurface({ base: BASE, head: HEAD, cwd: dir });
    expect(surface.changedFiles).toHaveLength(4);
    expect(surface.addedRuntimeDependencies).toContain("right");
    expect(surface.mergeBase).toMatch(SHA_PATTERN);
  });

  it("throws loudly on a malformed manifest at head", () => {
    const bad = mkdtempSync(join(tmpdir(), "change-context-bad-"));
    const badGit = (args) => execFileSync("git", args, { cwd: bad, encoding: "utf8" });
    badGit(["init", "-q", "-b", "main"]);
    badGit(["config", "user.email", "test@example.com"]);
    badGit(["config", "user.name", "Test"]);
    badGit(["config", "commit.gpgsign", "false"]);
    badGit(["config", "core.hooksPath", "/dev/null"]);
    writeFileSync(join(bad, PKG), `${JSON.stringify({ name: "x", dependencies: {} }, null, 2)}\n`);
    badGit(["add", "-A"]);
    badGit(["commit", "-q", "-m", "base"]);
    writeFileSync(join(bad, PKG), "{ not valid json ");
    badGit(["add", "-A"]);
    badGit(["commit", "-q", "-m", "bad"]);
    expect(() => collectChangeSurface({ base: BASE, head: HEAD, cwd: bad })).toThrow();
    rmSync(bad, { recursive: true, force: true });
  });
});
