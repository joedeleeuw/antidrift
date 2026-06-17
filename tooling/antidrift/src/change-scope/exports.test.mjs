import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { changedFilesBetween } from "./change-context.mjs";
import { collectExportChanges } from "./exports.mjs";

const BASE = "HEAD~1";
const HEAD = "HEAD";

let dir;

function runGitIn(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function configureGit(cwd) {
  runGitIn(cwd, ["init", "-q", "-b", "main"]);
  runGitIn(cwd, ["config", "user.email", "test@example.com"]);
  runGitIn(cwd, ["config", "user.name", "Test"]);
  runGitIn(cwd, ["config", "commit.gpgsign", "false"]);
  runGitIn(cwd, ["config", "core.hooksPath", "/dev/null"]);
}

function runGit(args) {
  return runGitIn(dir, args);
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "change-exports-"));
  configureGit(dir);

  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "src/public.ts"),
    [
      "export const existing = 1;",
      "export function removedValue() { return existing; }",
      "export interface Existing { id: string }",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(dir, "src/source.ts"),
    [
      "export const sourceValue = 1;",
      "export interface SourceType { id: string }",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(dir, "src/star.ts"),
    [
      "export const starValue = 1;",
      "export type StarType = { id: string };",
      "",
    ].join("\n"),
  );
  writeFileSync(join(dir, "src/index.ts"), "export * from './star';\n");
  writeFileSync(join(dir, "src/group.ts"), "export const groupedValue = 1;\n");
  writeFileSync(
    join(dir, "src/types.d.ts"),
    "export interface Generated { id: string }\n",
  );
  runGit(["add", "-A"]);
  runGit(["commit", "-q", "-m", "base"]);

  writeFileSync(
    join(dir, "src/public.ts"),
    [
      "export const existing = 2;",
      "export function addedValue() { return existing; }",
      "export type AddedType = { id: string };",
      "export default function defaultValue() { return existing; }",
      "export { sourceValue } from './source.js';",
      "export type { SourceType } from './source.js';",
      "export * from './star';",
      "export * as grouped from './group';",
      "export namespace publicNamespace { export const x = 1; }",
      "export interface Existing { id: string }",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(dir, "src/star.ts"),
    [
      "export const addedFromStar = 2;",
      "export const starValue = 1;",
      "export type StarType = { id: string };",
      "",
    ].join("\n"),
  );
  writeFileSync(join(dir, "src/new.ts"), "export const created = 1;\n");
  writeFileSync(
    join(dir, "src/view.tsx"),
    "export function View() { return <div />; }\n",
  );
  writeFileSync(
    join(dir, "src/types.d.ts"),
    [
      "export interface Generated { id: string; name: string }",
      "export interface AddedGenerated { id: string }",
      "",
    ].join("\n"),
  );
  runGit(["add", "-A"]);
  runGit(["commit", "-q", "-m", "head"]);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("collectExportChanges", () => {
  it("compares TypeScript exported symbols across refs", () => {
    const changedFiles = changedFilesBetween({
      base: BASE,
      head: HEAD,
      cwd: dir,
    });
    const result = collectExportChanges({
      base: BASE,
      head: HEAD,
      cwd: dir,
      changedFiles,
    });

    expect(result.addedExports).toEqual([
      { file: "src/index.ts", name: "addedFromStar", kind: "value" },
      { file: "src/new.ts", name: "created", kind: "value" },
      { file: "src/public.ts", name: "AddedType", kind: "type" },
      { file: "src/public.ts", name: "SourceType", kind: "type" },
      { file: "src/public.ts", name: "StarType", kind: "type" },
      { file: "src/public.ts", name: "addedFromStar", kind: "value" },
      { file: "src/public.ts", name: "addedValue", kind: "value" },
      { file: "src/public.ts", name: "default", kind: "default" },
      { file: "src/public.ts", name: "grouped", kind: "namespace" },
      { file: "src/public.ts", name: "publicNamespace", kind: "namespace" },
      { file: "src/public.ts", name: "sourceValue", kind: "value" },
      { file: "src/public.ts", name: "starValue", kind: "value" },
      { file: "src/star.ts", name: "addedFromStar", kind: "value" },
      { file: "src/types.d.ts", name: "AddedGenerated", kind: "type" },
      { file: "src/view.tsx", name: "View", kind: "value" },
    ]);
    expect(result.removedExports).toEqual([
      { file: "src/public.ts", name: "removedValue", kind: "value" },
    ]);
  });

  it("throws loudly when a public re-export target cannot resolve", () => {
    const broken = mkdtempSync(join(tmpdir(), "change-exports-broken-"));
    try {
      configureGit(broken);
      mkdirSync(join(broken, "src"), { recursive: true });
      writeFileSync(
        join(broken, "src/public.ts"),
        "export const existing = 1;\n",
      );
      runGitIn(broken, ["add", "-A"]);
      runGitIn(broken, ["commit", "-q", "-m", "base"]);
      writeFileSync(
        join(broken, "src/public.ts"),
        ["export const existing = 1;", "export * from './missing';", ""].join(
          "\n",
        ),
      );
      runGitIn(broken, ["add", "-A"]);
      runGitIn(broken, ["commit", "-q", "-m", "head"]);
      const changedFiles = changedFilesBetween({
        base: BASE,
        head: HEAD,
        cwd: broken,
      });
      expect(() =>
        collectExportChanges({
          base: BASE,
          head: HEAD,
          cwd: broken,
          changedFiles,
        }),
      ).toThrow(/could not resolve public re-export module/u);
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
  });
});
