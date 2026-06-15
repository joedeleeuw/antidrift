import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  countTypePredicateCandidates,
  undercheckedPredicateInventory,
} from "./underchecked-predicate-inventory.mjs";

function tempRepo() {
  return mkdtempSync(join(tmpdir(), "antidrift-underchecked-inventory-"));
}

function writeProgram(root, relativePath, source) {
  const fullPath = join(root, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, source, "utf8");
}

describe("undercheckedPredicateInventory", () => {
  it("counts type-predicate syntax separately from broad-input diagnostics", async () => {
    const root = tempRepo();
    writeProgram(
      root,
      "tsconfig.json",
      JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            target: "ES2022",
            module: "ESNext",
            moduleResolution: "Bundler",
            noEmit: true,
            skipLibCheck: true,
          },
          include: ["src/**/*.ts"],
        },
        null,
        2,
      ),
    );
    writeProgram(
      root,
      "src/drift.ts",
      `
type User = { id: string; email: string; active: boolean };

export function isUser(value: unknown): value is User {
  return value != null && typeof value === "object";
}
`,
    );
    writeProgram(
      root,
      "src/clean.ts",
      `
type User = { id: string; email: string; active: boolean };

export function isUser(value: unknown): value is User {
  return (
    value != null &&
    typeof value === "object" &&
    "id" in value &&
    "email" in value &&
    "active" in value
  );
}
`,
    );

    const result = await undercheckedPredicateInventory({
      plans: [
        {
          repo: "fixture",
          label: "app",
          repoCandidates: [root],
          tsconfig: "tsconfig.json",
          targets: ["src/**/*.ts"],
        },
      ],
      report: () => {},
      progress: () => {},
    });

    expect(result.decision).toBe("pass");
    expect(result.checkedFiles).toBe(2);
    expect(result.syntaxCandidateFiles).toBe(2);
    expect(result.syntaxCandidateCount).toBe(2);
    expect(result.parserErrors).toBe(0);
    expect(result.driftRepositories).toBe(1);
    expect(result.findingsByRule).toMatchObject({
      "antidrift/no-underchecked-type-predicate": 1,
    });
    expect(result.results[0].customFindings).toHaveLength(1);
    expect(result.results[0].findings).toBeUndefined();
  });

  it("recognizes type predicate signatures as inventory pressure", () => {
    expect(
      countTypePredicateCandidates(
        "function isUser(value: unknown): value is User { return true; }",
      ),
    ).toBe(1);
    expect(
      countTypePredicateCandidates(
        "function isUser(value: unknown): boolean { return true; }",
      ),
    ).toBe(0);
  });
});
