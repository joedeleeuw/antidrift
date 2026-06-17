import { describe, expect, it } from "vitest";

import { VIOLATION_TYPES, analyzeChangeScope, globToRegExp, matchesAnyGlob } from "./analyze.mjs";

const ORDERS_GLOB = "apps/shop/src/orders/**";

function contract(scopeOverrides = {}) {
  return {
    contractId: "TASK-1",
    scope: {
      allowedPaths: [ORDERS_GLOB],
      forbiddenPaths: [],
      allowedChangeTypes: [],
      allowedRuntimeDependencies: [],
      allowedDevDependencies: [],
      ...scopeOverrides,
    },
    refactor: { approved: false },
  };
}

function surface(overrides = {}) {
  return {
    changedFiles: [],
    addedRuntimeDependencies: [],
    addedDevDependencies: [],
    ...overrides,
  };
}

function changedFile(path, operation = "modify", oldPath = null) {
  return { path, operation, oldPath };
}

describe("globToRegExp", () => {
  it("matches ** across path separators", () => {
    expect(globToRegExp(ORDERS_GLOB).test("apps/shop/src/orders/format.ts")).toBe(true);
    expect(globToRegExp(ORDERS_GLOB).test("apps/shop/src/orders/deep/nested.ts")).toBe(true);
  });

  it("does not match a sibling directory", () => {
    expect(matchesAnyGlob("apps/shop/src/billing/index.ts", [ORDERS_GLOB])).toBe(false);
  });

  it("treats a single star as segment-local", () => {
    expect(globToRegExp("src/*.ts").test("src/a.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/a/b.ts")).toBe(false);
  });
});

describe("analyzeChangeScope", () => {
  it("stays clean when every change is in scope", () => {
    const result = analyzeChangeScope(contract(), surface({ changedFiles: [changedFile("apps/shop/src/orders/format.ts")] }));
    expect(result).toEqual([]);
  });

  it("flags a path outside the allowed scope", () => {
    const result = analyzeChangeScope(contract(), surface({ changedFiles: [changedFile("apps/shop/src/billing/tax.ts")] }));
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe(VIOLATION_TYPES.pathOutOfScope);
  });

  it("flags a forbidden path even inside an allowed tree", () => {
    const result = analyzeChangeScope(
      contract({ allowedPaths: ["apps/shop/**"], forbiddenPaths: ["apps/shop/src/billing/**"] }),
      surface({ changedFiles: [changedFile("apps/shop/src/billing/tax.ts")] }),
    );
    expect(result.map((violation) => violation.type)).toContain(VIOLATION_TYPES.forbiddenPath);
  });

  it("considers the old path of a rename for scope", () => {
    const result = analyzeChangeScope(
      contract({ allowedPaths: ["apps/shop/src/orders/**"] }),
      surface({ changedFiles: [changedFile("apps/shop/src/orders/new.ts", "rename", "apps/shop/src/billing/old.ts")] }),
    );
    expect(result.map((violation) => violation.type)).toContain(VIOLATION_TYPES.pathOutOfScope);
  });

  it("flags an undeclared runtime dependency", () => {
    const result = analyzeChangeScope(contract(), surface({ addedRuntimeDependencies: ["@copilotkit/react-core"] }));
    expect(result.map((violation) => violation.type)).toContain(VIOLATION_TYPES.undeclaredRuntimeDependency);
  });

  it("allows a declared runtime dependency", () => {
    const result = analyzeChangeScope(
      contract({ allowedRuntimeDependencies: ["@speckit/core"] }),
      surface({ addedRuntimeDependencies: ["@speckit/core"] }),
    );
    expect(result).toEqual([]);
  });

  it("flags a change type outside the declared set", () => {
    const result = analyzeChangeScope(
      contract({ allowedChangeTypes: ["modify"] }),
      surface({ changedFiles: [changedFile("apps/shop/src/orders/old.ts", "delete")] }),
    );
    expect(result.map((violation) => violation.type)).toContain(VIOLATION_TYPES.undeclaredChangeType);
  });
});
