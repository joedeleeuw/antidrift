import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { schemaRoundtripInventory } from "./schema-roundtrip-inventory.mjs";

const codebaseAtlasRoot =
  process.env.CODEBASE_ATLAS_REPO ?? "/Users/sushi/code/codebase-atlas";

describe("schemaRoundtripInventory", () => {
  it("classifies real Codebase Atlas schema roundtrips without blocking", () => {
    if (!existsSync(codebaseAtlasRoot)) {
      const skipped = schemaRoundtripInventory({
        repo: ["codebase-atlas"],
        report: () => {},
      });

      expect(skipped.decision).toBe("skip");
      return;
    }

    const result = schemaRoundtripInventory({
      repo: ["codebase-atlas"],
      targets: ["src/programs/lanternController.ts"],
      report: () => {},
    });

    const app = result.results.find((entry) => entry.repo === "codebase-atlas");
    expect(app?.decision).toBe("pass");

    const moveTo = app?.findings.find(
      (finding) => finding.enclosing === "LanternController.moveTo",
    );
    expect(moveTo).toMatchObject({
      path: "src/programs/lanternController.ts",
      schemaName: "ExplorationStateSchema",
      classification: "cross-source",
      candidateKind: "cross-source-invariant-checkpoint",
      exportBoundary: true,
    });
    expect(moveTo?.reasons).toContain("override-from-cross-source");

    const markUnderstood = app?.findings.find(
      (finding) => finding.enclosing === "markExplorationTileUnderstood",
    );
    expect(markUnderstood).toMatchObject({
      path: "src/programs/lanternController.ts",
      schemaName: "ExplorationStateSchema",
      classification: "owned-only",
      candidateKind: "owner-transition-helper-candidate",
      exportBoundary: true,
    });
    expect(markUnderstood?.reasons).toContain("object-spread-same-output");
    expect(markUnderstood?.reasons).toContain(
      "owner-transition-helper-candidate",
    );
  });
});
