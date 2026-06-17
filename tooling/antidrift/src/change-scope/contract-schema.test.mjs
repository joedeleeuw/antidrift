import { describe, expect, it } from "vitest";

import {
  ContractValidationError,
  parseContract,
  validateContract,
} from "./contract-schema.mjs";

const CONTRACT_ID = "TASK-1";
const NARROW_GLOB = "apps/shop/src/orders/**";

function rawContract(overrides = {}) {
  return {
    schemaVersion: 1,
    contractId: CONTRACT_ID,
    scope: { allowedPaths: [NARROW_GLOB] },
    ...overrides,
  };
}

describe("parseContract", () => {
  it("parses and normalizes a valid YAML contract", () => {
    const contract = parseContract(
      [
        "schemaVersion: 1",
        `contractId: ${CONTRACT_ID}`,
        "scope:",
        `  allowedPaths:`,
        `    - ${NARROW_GLOB}`,
        "  allowedChangeTypes:",
        "    - modify",
      ].join("\n"),
    );
    expect(contract.contractId).toBe(CONTRACT_ID);
    expect(contract.scope.allowedPaths).toEqual([NARROW_GLOB]);
    expect(contract.scope.allowedChangeTypes).toEqual(["modify"]);
    expect(contract.refactor.approved).toBe(false);
  });

  it("throws loudly on unparseable input", () => {
    expect(() => parseContract("contractId: [unterminated")).toThrow(
      ContractValidationError,
    );
  });
});

describe("validateContract", () => {
  it("rejects an empty contractId", () => {
    expect(() => validateContract(rawContract({ contractId: "" }))).toThrow(
      /contractId/u,
    );
  });

  it("rejects empty allowedPaths", () => {
    expect(() =>
      validateContract(rawContract({ scope: { allowedPaths: [] } })),
    ).toThrow(/allowedPaths/u);
  });

  it("rejects an absolute path", () => {
    expect(() =>
      validateContract(
        rawContract({ scope: { allowedPaths: ["/etc/passwd"] } }),
      ),
    ).toThrow(/absolute/u);
  });

  it("rejects a parent-directory traversal", () => {
    expect(() =>
      validateContract(
        rawContract({ scope: { allowedPaths: ["../secrets/**"] } }),
      ),
    ).toThrow(/\.\./u);
  });

  it("rejects a broad glob without refactor.approved", () => {
    expect(() =>
      validateContract(rawContract({ scope: { allowedPaths: ["**"] } })),
    ).toThrow(/broad glob/u);
  });

  it("accepts a broad glob when refactor.approved has a justification", () => {
    const contract = validateContract(
      rawContract({
        scope: { allowedPaths: ["**"] },
        refactor: { approved: true, justification: "repo-wide format sweep" },
      }),
    );
    expect(contract.refactor.approved).toBe(true);
    expect(contract.refactor.justification).toBe("repo-wide format sweep");
  });

  it("rejects refactor.approved without a justification", () => {
    expect(() =>
      validateContract(
        rawContract({
          scope: { allowedPaths: ["**"] },
          refactor: { approved: true },
        }),
      ),
    ).toThrow(/justification/u);
  });

  it("rejects a malformed allowedExports entry", () => {
    expect(() =>
      validateContract(
        rawContract({
          scope: {
            allowedPaths: [NARROW_GLOB],
            allowedExports: [{ file: "a.ts" }],
          },
        }),
      ),
    ).toThrow(/allowedExports/u);
  });

  it("preserves advanced scope fields", () => {
    const contract = validateContract(
      rawContract({
        scope: {
          allowedPaths: [NARROW_GLOB],
          allowedEntrypoints: ["apps/shop/page.tsx"],
          allowedExports: [{ file: "a.ts", name: "f", kind: "value" }],
          allowedOwnerSymbols: ["GeneratedUser"],
          maxTouchedModuleRadius: 1,
        },
      }),
    );
    expect(contract.scope.allowedEntrypoints).toEqual(["apps/shop/page.tsx"]);
    expect(contract.scope.allowedOwnerSymbols).toEqual(["GeneratedUser"]);
    expect(contract.scope.maxTouchedModuleRadius).toBe(1);
    expect(contract.scope.allowedExports).toEqual([
      { file: "a.ts", name: "f", kind: "value" },
    ]);
  });

  it("accepts typed allowed exports", () => {
    const contract = validateContract(
      rawContract({
        scope: {
          allowedPaths: [NARROW_GLOB],
          allowedExports: [{ file: "a.ts", name: "User", kind: "type" }],
        },
      }),
    );
    expect(contract.scope.allowedExports).toEqual([
      { file: "a.ts", name: "User", kind: "type" },
    ]);
  });

  it("rejects an invalid allowed export kind", () => {
    expect(() =>
      validateContract(
        rawContract({
          scope: {
            allowedPaths: [NARROW_GLOB],
            allowedExports: [{ file: "a.ts", name: "User", kind: "class" }],
          },
        }),
      ),
    ).toThrow(/allowedExports kind/u);
  });

  it("rejects an unknown top-level key", () => {
    expect(() => validateContract(rawContract({ bogus: 1 }))).toThrow(
      /unknown top-level key/u,
    );
  });

  it("rejects an invalid change type", () => {
    expect(() =>
      validateContract(
        rawContract({
          scope: {
            allowedPaths: [NARROW_GLOB],
            allowedChangeTypes: ["frobnicate"],
          },
        }),
      ),
    ).toThrow(/allowedChangeTypes/u);
  });

  it("collects multiple problems in one error", () => {
    try {
      validateContract({
        schemaVersion: 2,
        contractId: "",
        scope: { allowedPaths: [] },
      });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ContractValidationError);
      expect(error.problems.length).toBeGreaterThanOrEqual(3);
    }
  });
});
