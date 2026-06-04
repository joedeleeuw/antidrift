import { describe, expect, it } from "vitest";
import { createConfig } from "./index.mjs";

function collectRules(configs) {
  const rules = {};
  for (const config of configs) {
    Object.assign(rules, config?.rules ?? {});
  }
  return rules;
}

function severity(ruleValue) {
  return Array.isArray(ruleValue) ? ruleValue[0] : ruleValue;
}

describe("createConfig", () => {
  it("registers maintained ecosystem coverage for delegated policy areas", () => {
    const rules = collectRules(createConfig({ tsconfigRootDir: process.cwd() }));

    expect(severity(rules["sonarjs/sql-queries"])).toBe("error");

    expect(severity(rules["react-hooks/set-state-in-effect"])).toBe("error");
    expect(severity(rules["react-hooks/set-state-in-render"])).toBe("error");
    expect(severity(rules["react-hooks/immutability"])).toBe("error");
    expect(severity(rules["react-hooks/refs"])).toBe("error");
    expect(severity(rules["react-hooks/no-deriving-state-in-effects"])).toBe("error");

    expect(severity(rules["vitest/no-focused-tests"])).toBe("error");
    expect(severity(rules["vitest/no-disabled-tests"])).toBe("error");
    expect(severity(rules["vitest/no-conditional-expect"])).toBe("error");
    expect(severity(rules["vitest/expect-expect"])).toBe("error");
  });
});
