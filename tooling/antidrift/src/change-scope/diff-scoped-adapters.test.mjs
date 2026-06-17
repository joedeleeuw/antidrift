import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { diffScopedAdapters, parseArgs } from "./diff-scoped-adapters.mjs";

const BASE = "HEAD~1";
const HEAD = "HEAD";
const PLUGIN_URL = pathToFileURL(
  resolve("tooling/antidrift/src/eslint-plugin/index.js"),
).href;

let dir;

function runGit(args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

function writeConfig() {
  writeFileSync(
    resolve(dir, "eslint.config.mjs"),
    [
      `import plugin from ${JSON.stringify(PLUGIN_URL)};`,
      "export default [{",
      "  files: ['**/*.js'],",
      "  languageOptions: { ecmaVersion: 2023, sourceType: 'module' },",
      "  plugins: { antidrift: plugin },",
      "  rules: {",
      "    'antidrift/no-async-array-method': 'error',",
      "    'antidrift/no-shattered-ingested-entity-state': 'error',",
      "  },",
      "}];",
      "",
    ].join("\n"),
  );
}

beforeAll(() => {
  dir = mkdtempSync(resolve(tmpdir(), "diff-scoped-adapters-"));
  runGit(["init", "-q", "-b", "main"]);
  runGit(["config", "user.email", "test@example.com"]);
  runGit(["config", "user.name", "Test"]);
  runGit(["config", "commit.gpgsign", "false"]);
  runGit(["config", "core.hooksPath", "/dev/null"]);
  writeConfig();
  writeFileSync(
    resolve(dir, "app.js"),
    [
      "export async function preexisting(items) {",
      "  items.forEach(async (item) => {",
      "    await item.save();",
      "  });",
      "}",
      "",
    ].join("\n"),
  );
  runGit(["add", "-A"]);
  runGit(["commit", "-q", "-m", "base"]);
  writeFileSync(
    resolve(dir, "app.js"),
    [
      "export async function preexisting(items) {",
      "  items.forEach(async (item) => {",
      "    await item.save();",
      "  });",
      "}",
      "",
      "export async function added(items) {",
      "  items.forEach(async (item) => {",
      "    await item.save();",
      "  });",
      "}",
      "",
      "function ProfileCard() {",
      "  const [id, setId] = useState('');",
      "  const [name, setName] = useState('');",
      "  return async function load() {",
      "    const profile = await fetchProfile();",
      "    setId(profile.id);",
      "    setName(profile.displayName);",
      "  };",
      "}",
      "void ProfileCard;",
      "",
    ].join("\n"),
  );
  runGit(["add", "-A"]);
  runGit(["commit", "-q", "-m", "head"]);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("diffScopedAdapters", () => {
  it("keeps only ESLint findings on changed hunk lines", async () => {
    const summary = await diffScopedAdapters({
      base: BASE,
      head: HEAD,
      cwd: dir,
      report() {},
    });

    expect(summary.decision).toBe("inventory");
    expect(summary.checkedFiles).toEqual(["app.js"]);
    expect(summary.findingCounts.total).toBe(2);
    expect(summary.findingCounts.diffScoped).toBe(1);
    expect(summary.findingCounts.byRule).toEqual({
      "antidrift/no-async-array-method": 1,
    });
    expect(summary.findings).toEqual([
      expect.objectContaining({
        path: "app.js",
        ruleId: "antidrift/no-async-array-method",
        line: 8,
      }),
    ]);
    expect(summary.factCounts.total).toBe(1);
    expect(summary.factCounts.diffScoped).toBe(1);
    expect(summary.factCounts.byFactKind).toEqual({
      sourceMemberStateShardCandidate: 1,
    });
    expect(summary.facts).toEqual([
      expect.objectContaining({
        path: "app.js",
        factKind: "sourceMemberStateShardCandidate",
        ruleId: "antidrift/no-shattered-ingested-entity-state",
        payload: expect.objectContaining({
          source: "profile",
          members: expect.arrayContaining([
            { setter: "setId", cell: "id", property: "id" },
            { setter: "setName", cell: "name", property: "displayName" },
          ]),
        }),
      }),
    ]);
  });

  it("parses strict CLI flags", () => {
    expect(
      parseArgs(["--base", "main", "--head", "HEAD", "--slice", "ci"]),
    ).toMatchObject({ base: "main", head: "HEAD", slice: "ci" });
    expect(() => parseArgs(["--base", "--head"])).toThrow(/requires a value/u);
    expect(() => parseArgs(["--bogus"])).toThrow(/unknown argument/u);
  });
});
