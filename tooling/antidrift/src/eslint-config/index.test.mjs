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
  it("enables every custom TypeChecker rule", () => {
    const rules = collectRules(
      createConfig({ tsconfigRootDir: process.cwd() }),
    );

    for (const ruleId of [
      "antidrift/no-appeasement-cast",
      "antidrift/no-canonical-model-fork",
      "antidrift/no-contract-appeasement-projection",
      "antidrift/no-defensive-shape-probing",
      "antidrift/no-nullable-positional-tuple",
      "antidrift/no-redundant-zod-parse",
      "antidrift/no-sql-string-concat",
      "antidrift/no-structural-type-fork",
      "antidrift/no-underchecked-type-predicate",
      "antidrift/no-unsafe-deserialize",
      "antidrift/react-max-component-props",
    ]) {
      expect(severity(rules[ruleId])).toBe("error");
    }
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
