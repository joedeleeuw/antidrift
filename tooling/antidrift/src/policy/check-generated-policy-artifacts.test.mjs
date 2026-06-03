import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkGenerated } from "./check-generated-policy-artifacts.mjs";

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "antidrift-generated-"));
  mkdirSync(join(root, "policy"), { recursive: true });
  writeFileSync(join(root, "policy/agent-guardrails.yaml"), `
clusters:
  - id: sample
    owner: platform
    rules:
      - id: sample/rule
`);
  return root;
}

describe("checkGenerated", () => {
  it("reports stale generated files without rewriting them", async () => {
    const root = workspace();
    writeFileSync(join(root, "AGENTS.md"), "stale\n");
    const messages = [];

    await expect(checkGenerated({ repoRoot: root, report: (message) => messages.push(message) })).resolves.toBe(false);

    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe("stale\n");
    expect(messages.join("\n")).toContain("Generated policy artifact was stale: AGENTS.md");
  });
});
