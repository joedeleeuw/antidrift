import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { chaskiCorpus } from "./chaski-corpus.mjs";
import { externalCorpus } from "./external-corpus.mjs";

function tempRepo() {
  return mkdtempSync(join(tmpdir(), "antidrift-chaski-corpus-"));
}

function writeProgram(root, relativePath, source) {
  const fullPath = join(root, relativePath);
  mkdirSync(join(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, source, "utf8");
}

describe("chaskiCorpus", () => {
  it("skips when Chaski is unavailable and not required", async () => {
    const messages = [];
    const result = await chaskiCorpus({
      repo: "/definitely/not/chaski",
      report: (message) => messages.push(message),
    });

    expect(result.decision).toBe("skip");
    expect(messages.join("\n")).toContain("Chaski repo not found");
  });

  it("asserts drift and clean real-source cases", async () => {
    const root = tempRepo();
    writeProgram(
      root,
      "src/frontend/bff/api/tests/project-cleanup.ts",
      "async function close(id: string) { return id; }\nconst openedProjectIds = ['a'];\nopenedProjectIds.forEach(async (id) => close(id));\n",
    );
    writeProgram(
      root,
      "src/frontend/bff/api/services/project-cleanup.ts",
      "async function close(id: string) { return id; }\nconst openedProjectIds = ['a'];\nawait Promise.all(openedProjectIds.map(async (id) => close(id)));\n",
    );

    const result = await chaskiCorpus({
      repo: root,
      cases: [
        {
          id: "drift",
          ruleId: "antidrift/no-async-array-method",
          kind: "drift",
          classification: "ready",
          subproject: "bff",
          paths: ["src/frontend/bff/api/tests/project-cleanup.ts"],
          expectedFindings: [
            {
              path: "src/frontend/bff/api/tests/project-cleanup.ts",
              line: 3,
            },
          ],
        },
        {
          id: "clean",
          ruleId: "antidrift/no-async-array-method",
          kind: "correct",
          classification: "ready",
          subproject: "bff",
          paths: ["src/frontend/bff/api/services/project-cleanup.ts"],
        },
      ],
      report: () => {},
    });

    expect(result.decision).toBe("pass");
    expect(
      result.cases.find((testCase) => testCase.id === "drift")?.findings,
    ).toHaveLength(1);
    expect(
      result.cases.find((testCase) => testCase.id === "clean")?.findings,
    ).toHaveLength(0);
  });

  it("skips when a rule filter selects no corpus cases", async () => {
    const root = tempRepo();
    writeProgram(root, "src/example.ts", "export const ok = true;\n");

    const result = await chaskiCorpus({
      repo: root,
      rules: ["antidrift/no-coupled-state-setters"],
      cases: [
        {
          id: "clean",
          ruleId: "antidrift/no-async-array-method",
          kind: "correct",
          classification: "ready",
          subproject: "app",
          paths: ["src/example.ts"],
        },
      ],
      report: () => {},
    });

    expect(result.decision).toBe("skip");
    expect(result.reason).toContain("No corpus cases matched");
  });

  it("can run type-aware Chaski cases against a subproject tsconfig", async () => {
    const root = tempRepo();
    writeProgram(
      root,
      "src/frontend/bff/tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          strict: true,
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          noEmit: true,
        },
        include: ["**/*.ts"],
      }),
    );
    writeProgram(
      root,
      "src/frontend/bff/api/shape.ts",
      `declare const raw: Record<string, unknown>;

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

    const result = await chaskiCorpus({
      repo: root,
      cases: [
        {
          id: "typed-drift",
          ruleId: "antidrift/no-defensive-shape-probing",
          kind: "drift",
          classification: "ready",
          subproject: "bff",
          typeAware: true,
          paths: ["src/frontend/bff/api/shape.ts"],
          expectedFindings: [
            { path: "src/frontend/bff/api/shape.ts", line: 4 },
          ],
        },
      ],
      report: () => {},
    });

    expect(result.decision).toBe("pass");
    expect(result.cases[0]?.findings).toHaveLength(1);
  });

  it("records known gaps without blocking corpus validation", async () => {
    const root = tempRepo();
    writeProgram(
      root,
      "src/example.ts",
      "type Order = { id: string };\ndeclare const raw: unknown;\nconst order = raw as Order;\nvoid order;\n",
    );

    const result = await chaskiCorpus({
      repo: root,
      cases: [
        {
          id: "known-gap",
          ruleId: "antidrift/no-appeasement-cast",
          kind: "known-gap",
          classification: "ready",
          subproject: "app",
          paths: ["src/example.ts"],
          reason: "Documented but not currently blocking.",
        },
      ],
      report: () => {},
    });

    expect(result.decision).toBe("pass");
    expect(result.cases[0]?.decision).toBe("known-gap");
    expect(result.cases[0]?.findings).toHaveLength(1);
  });

  it("fails when ESLint cannot parse a corpus source file", async () => {
    const root = tempRepo();
    writeProgram(root, "src/broken.ts", "const = ;\n");

    const result = await chaskiCorpus({
      repo: root,
      cases: [
        {
          id: "broken",
          ruleId: "antidrift/no-appeasement-cast",
          kind: "correct",
          classification: "ready",
          subproject: "app",
          paths: ["src/broken.ts"],
        },
      ],
      report: () => {},
    });

    expect(result.decision).toBe("fail");
    expect(result.cases[0]?.findings[0]?.ruleId).toBeNull();
    expect(result.cases[0]?.reason).toContain("ESLint could not evaluate");
  });
});

describe("externalCorpus", () => {
  it("can require more than one external repository for promotion gates", async () => {
    const root = tempRepo();
    writeProgram(
      root,
      "src/example.ts",
      "async function close(id: string) { return id; }\nconst ids = ['a'];\nids.forEach(async (id) => close(id));\n",
    );

    const result = await externalCorpus({
      corpus: "sudocode-main",
      repo: root,
      minRepositories: 2,
      cases: [
        {
          id: "async-array-method",
          ruleId: "antidrift/no-async-array-method",
          kind: "drift",
          classification: "ready",
          subproject: "app",
          paths: ["src/example.ts"],
          expectedFindings: [{ path: "src/example.ts", line: 3 }],
        },
      ],
      report: () => {},
    });

    expect(result.decision).toBe("fail");
    expect(result.reason).toContain("2 required");
    expect(result.repositories).toHaveLength(1);
    expect(result.repositories[0]?.decision).toBe("pass");
  });

  it("can require drift-bearing repositories for promotion gates", async () => {
    const root = tempRepo();
    writeProgram(
      root,
      "src/example.ts",
      "async function close(id: string) { return id; }\nconst ids = ['a'];\nids.forEach(async (id) => close(id));\n",
    );

    const result = await externalCorpus({
      corpus: "sudocode-main",
      repo: root,
      minDriftRepositories: 2,
      cases: [
        {
          id: "async-array-method",
          ruleId: "antidrift/no-async-array-method",
          kind: "drift",
          classification: "ready",
          subproject: "app",
          paths: ["src/example.ts"],
          expectedFindings: [{ path: "src/example.ts", line: 3 }],
        },
      ],
      report: () => {},
    });

    expect(result.decision).toBe("fail");
    expect(result.reason).toContain("drift cases");
    expect(result.driftRepositories).toBe(1);
    expect(result.repositories[0]?.decision).toBe("pass");
  });
});
