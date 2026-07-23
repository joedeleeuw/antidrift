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

function collectSettings(configs) {
  const settings = {};
  for (const config of configs) {
    Object.assign(settings, config?.settings ?? {});
  }
  return settings;
}

describe("createConfig", () => {
  it("enables only the active custom TypeChecker rules", () => {
    const rules = collectRules(
      createConfig({ tsconfigRootDir: process.cwd() }),
    );

    expect(
      severity(rules["antidrift/no-contract-appeasement-projection"]),
    ).toBe("error");
    expect(severity(rules["antidrift/react-max-component-props"])).toBe(
      "error",
    );
    expect(severity(rules["antidrift/no-redundant-zod-parse"])).toBe("error");
    expect(severity(rules["antidrift/no-unsafe-deserialize"])).toBe("error");
    expect(rules["antidrift/no-structural-type-fork"]).toBe("off");
    expect(rules["antidrift/require-effect-deps"]).toBeUndefined();
    expect(rules["react/rules-of-hooks"]).toBeUndefined();
  });

  it("wires semantic fact settings through the public config API", () => {
    const sink = { emit() {} };
    const settings = collectSettings(
      createConfig({
        tsconfigRootDir: process.cwd(),
        semanticFacts: { repoRoot: process.cwd(), sink },
      }),
    );

    expect(settings.antidrift).toEqual({
      semanticFacts: { repoRoot: process.cwd(), sink },
    });
  });
});
