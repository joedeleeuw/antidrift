import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  defensiveShapeInventory,
  isEntryTransformCandidate,
} from "./defensive-shape-inventory.mjs";

function tempRepo() {
  return mkdtempSync(join(tmpdir(), "antidrift-defensive-shape-inventory-"));
}

function writeProgram(root, relativePath, source) {
  const fullPath = join(root, relativePath);
  mkdirSync(join(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, source, "utf8");
}

describe("defensiveShapeInventory", () => {
  it("counts syntax pressure separately from broad-value diagnostics", async () => {
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
declare const raw: Record<string, unknown>;

export const normalized = Object.fromEntries(
  Object.entries(raw).map(([key, value]) => {
    if (value && typeof value === "object") {
      return [
        key,
        ("numberValue" in value ? value.numberValue : undefined) ??
          ("stringValue" in value ? value.stringValue : undefined) ??
          ("boolValue" in value ? value.boolValue : undefined) ??
          null,
      ];
    }
    return [key, value];
  }),
);
`,
    );
    writeProgram(
      root,
      "src/typed.ts",
      `
type User = { name: string; enabled: boolean };
declare const users: Record<string, User>;

export const labels = Object.entries(users).map(([id, user]) => [
  id,
  user.enabled ? user.name : "disabled",
]);
`,
    );

    const result = await defensiveShapeInventory({
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
    expect(result.parserErrors).toBe(0);
    expect(result.driftRepositories).toBe(1);
    expect(result.findingsByRule).toMatchObject({
      "antidrift/no-defensive-shape-probing": 1,
    });
  });

  it("recognizes Object.entries transform syntax as inventory pressure", () => {
    expect(
      isEntryTransformCandidate(
        "Object.entries(values).flatMap(([key, value]) => [key, value])",
      ),
    ).toBe(true);
    expect(isEntryTransformCandidate("Object.entries(values);")).toBe(false);
  });
});
