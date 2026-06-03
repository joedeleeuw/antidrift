import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chaskiCorpus } from "./chaski-corpus.mjs";

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
      "src/frontend/bff/api/gateways/posthog-gateway.ts",
      "type Order = { id: string };\ndeclare const raw: unknown;\nconst order = raw as unknown as Order;\nvoid order;\n",
    );
    writeProgram(
      root,
      "src/frontend/bff/api/services/orders-service.ts",
      "type Order = { id: string };\ndeclare const order: Order;\nvoid order;\n",
    );

    const result = await chaskiCorpus({
      repo: root,
      cases: [
        {
          id: "drift",
          ruleId: "antidrift/no-unsafe-cast-chain",
          kind: "drift",
          classification: "ready",
          subproject: "bff",
          paths: ["src/frontend/bff/api/gateways/posthog-gateway.ts"],
          expectedFindings: [{ path: "src/frontend/bff/api/gateways/posthog-gateway.ts", line: 3 }],
        },
        {
          id: "clean",
          ruleId: "antidrift/no-unsafe-cast-chain",
          kind: "correct",
          classification: "ready",
          subproject: "bff",
          paths: ["src/frontend/bff/api/services/orders-service.ts"],
        },
      ],
      report: () => {},
    });

    expect(result.decision).toBe("pass");
    expect(result.cases.find((testCase) => testCase.id === "drift")?.findings).toHaveLength(1);
    expect(result.cases.find((testCase) => testCase.id === "clean")?.findings).toHaveLength(0);
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
      `type WireValue = {
  numberValue?: number;
  stringValue?: string;
  boolValue?: boolean;
};

declare const raw: Record<string, WireValue | string | null>;

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
          expectedFindings: [{ path: "src/frontend/bff/api/shape.ts", line: 10 }],
        },
      ],
      report: () => {},
    });

    expect(result.decision).toBe("pass");
    expect(result.cases[0]?.findings).toHaveLength(1);
  });
});
