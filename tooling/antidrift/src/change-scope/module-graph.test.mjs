import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { collectTouchedModuleGraph } from "./module-graph.mjs";

let dir;

function makeDir() {
  dir = mkdtempSync(join(tmpdir(), "module-graph-radius-"));
  mkdirSync(join(dir, "src/feature/deep"), { recursive: true });
  runGit(["init", "-q", "-b", "main"]);
  runGit(["config", "user.email", "test@example.com"]);
  runGit(["config", "user.name", "Test"]);
  runGit(["config", "commit.gpgsign", "false"]);
  runGit(["config", "core.hooksPath", "/dev/null"]);
}

function runGit(args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

function write(path, content) {
  writeFileSync(join(dir, path), content);
}

function writeProject() {
  write(
    "tsconfig.json",
    `${JSON.stringify(
      {
        compilerOptions: {
          module: "ESNext",
          moduleResolution: "Bundler",
          target: "ES2022",
          strict: true,
        },
        include: ["src/**/*.ts"],
      },
      null,
      2,
    )}\n`,
  );
  write(
    "src/page.ts",
    [
      'import { format } from "./feature/format";',
      'export { alt } from "./alt";',
      'export async function loadLazy() { return import("./lazy"); }',
      "export const page = format();",
      "",
    ].join("\n"),
  );
  write(
    "src/feature/format.ts",
    [
      'import { helper } from "./deep/helper";',
      "export function format() {",
      "  return helper();",
      "}",
      "",
    ].join("\n"),
  );
  write("src/feature/deep/helper.ts", "export const helper = () => 1;\n");
  write("src/alt.ts", "export const alt = 1;\n");
  write("src/lazy.ts", "export const lazy = 1;\n");
  runGit(["add", "-A"]);
  runGit(["commit", "-q", "-m", "project"]);
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe("collectTouchedModuleGraph", () => {
  it("computes touched-file distance from static imports, re-exports, and dynamic imports", () => {
    makeDir();
    writeProject();

    const result = collectTouchedModuleGraph({
      cwd: dir,
      head: "HEAD",
      tsconfig: "tsconfig.json",
      changedFiles: [
        { path: "src/feature/format.ts", operation: "modify", oldPath: null },
        { path: "src/alt.ts", operation: "modify", oldPath: null },
        { path: "src/lazy.ts", operation: "modify", oldPath: null },
        {
          path: "src/feature/deep/helper.ts",
          operation: "modify",
          oldPath: null,
        },
      ],
      allowedEntrypoints: ["src/page.ts"],
      maxTouchedModuleRadius: 1,
    });

    expect(result.entrypoints).toEqual(["src/page.ts"]);
    expect(result.edges).toBe(4);
    expect(
      Object.fromEntries(
        result.touchedFiles.map((file) => [file.path, file.distance]),
      ),
    ).toEqual({
      "src/alt.ts": 1,
      "src/feature/deep/helper.ts": 2,
      "src/feature/format.ts": 1,
      "src/lazy.ts": 1,
    });
    expect(result.outOfRadius).toEqual([
      expect.objectContaining({
        path: "src/feature/deep/helper.ts",
        distance: 2,
        withinRadius: false,
      }),
    ]);
  });

  it("uses the selected head tree instead of dirty worktree imports", () => {
    makeDir();
    writeProject();
    write(
      "src/page.ts",
      [
        'import { helper } from "./feature/deep/helper";',
        "export const page = helper();",
        "",
      ].join("\n"),
    );

    const result = collectTouchedModuleGraph({
      cwd: dir,
      head: "HEAD",
      tsconfig: "tsconfig.json",
      changedFiles: [
        {
          path: "src/feature/deep/helper.ts",
          operation: "modify",
          oldPath: null,
        },
      ],
      allowedEntrypoints: ["src/page.ts"],
      maxTouchedModuleRadius: 1,
    });

    expect(result.touchedFiles).toEqual([
      expect.objectContaining({
        path: "src/feature/deep/helper.ts",
        distance: 2,
        withinRadius: false,
      }),
    ]);
  });

  it("throws when the declared entrypoint is not in the selected program", () => {
    makeDir();
    writeProject();

    expect(() =>
      collectTouchedModuleGraph({
        cwd: dir,
        head: "HEAD",
        tsconfig: "tsconfig.json",
        changedFiles: [],
        allowedEntrypoints: ["src/missing.ts"],
      }),
    ).toThrow(/allowedEntrypoints missing/u);
  });

  it("throws when a changed TypeScript file is outside the selected program", () => {
    makeDir();
    writeProject();
    mkdirSync(join(dir, "other"), { recursive: true });
    write("other/stray.ts", "export const stray = 1;\n");

    expect(() =>
      collectTouchedModuleGraph({
        cwd: dir,
        head: "HEAD",
        tsconfig: "tsconfig.json",
        changedFiles: [
          { path: "other/stray.ts", operation: "modify", oldPath: null },
        ],
        allowedEntrypoints: ["src/page.ts"],
      }),
    ).toThrow(/not included by the selected tsconfig/u);
  });
});
