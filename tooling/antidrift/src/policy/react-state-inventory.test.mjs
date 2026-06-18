import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  classifyReactStateFact,
  parseArgs,
  reactStateInventory,
} from "./react-state-inventory.mjs";

function tempRepo() {
  return mkdtempSync(join(tmpdir(), "antidrift-react-state-inventory-"));
}

function writeProgram(root, relativePath, source) {
  const fullPath = join(root, relativePath);
  mkdirSync(join(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, source, "utf8");
}

describe("reactStateInventory", () => {
  it("parses brace target globs without splitting inside the braces", () => {
    expect(
      parseArgs([
        "--targets",
        "src/**/*.{ts,tsx},apps/**/*.tsx",
        "--threshold",
        "2",
      ]),
    ).toMatchObject({
      targets: ["src/**/*.{ts,tsx}", "apps/**/*.tsx"],
      threshold: 2,
    });
  });

  it("classifies lifecycle proof and broad co-mutation facts without failing the inventory", async () => {
    const root = tempRepo();
    writeProgram(
      root,
      "src/component.tsx",
      `
import { useState } from "react";

declare function loadUsers(): Promise<string[]>;

export function Users() {
  const [users, setUsers] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);

  async function refresh() {
    setPending(true);
    setFailure(null);
    try {
      const result = await loadUsers();
      setUsers(result);
    } catch (error) {
      setFailure(error);
    } finally {
      setPending(false);
    }
  }

  function updateQuery(next: string) {
    setQuery(next);
    setPage(1);
    setSelected(null);
  }

  return { refresh, updateQuery };
}
`,
    );

    const result = await reactStateInventory({
      repoRoot: root,
      targets: ["src/**/*.tsx"],
      report: () => {},
    });

    expect(result.decision).toBe("pass");
    expect(result.factCounts).toMatchObject({
      broadSetterCoMutation: 1,
      resourceLifecycleProof: 1,
    });
    expect(result.bucketCounts).toMatchObject({
      "blocking-resource-lifecycle": 1,
      "synchronous-multi-cell-update": 1,
    });
    expect(result.diagnosticCount).toBe(1);
    expect(result.facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          factKind: "resourceLifecycleProof",
          boolCell: "setPending",
          errorCell: "setFailure",
          payloadCell: "setUsers",
        }),
      ]),
    );
  });

  it("classifies partial async resource updates separately from proven lifecycle drift", () => {
    const bucket = classifyReactStateFact({
      factKind: "broadSetterCoMutation",
      payload: {
        transition: true,
        requestGuard: false,
        cells: {
          setRows: { writes: ["awaited"] },
          setFailure: { writes: ["caughtError"] },
          setPending: { writes: ["falseConst", "trueConst"] },
        },
      },
    });

    expect(bucket).toBe("partial-resource-lifecycle");
  });
});
