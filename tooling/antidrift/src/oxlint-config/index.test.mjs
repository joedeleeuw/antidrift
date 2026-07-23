import { describe, expect, it } from "vitest";

import { createOxlintConfig } from "./index.mjs";

function severity(ruleValue) {
  return Array.isArray(ruleValue) ? ruleValue[0] : ruleValue;
}

describe("createOxlintConfig", () => {
  it("owns the native, type-aware, and syntax-only policy baseline", () => {
    const config = createOxlintConfig({ repoRoot: process.cwd() });

    expect(config.options.typeAware).toBe(true);
    expect(severity(config.rules["react/react-compiler"])).toBe("error");
    expect(severity(config.rules["typescript/no-misused-promises"])).toBe(
      "error",
    );
    expect(severity(config.rules["boundaries/element-types"])).toBe("error");
    expect(severity(config.rules["no-nested-ternary"])).toBe("error");
    expect(severity(config.rules["antidrift/require-effect-deps"])).toBe(
      "error",
    );
  });

  it("keeps test integrity rules active in test files", () => {
    const config = createOxlintConfig({ repoRoot: process.cwd() });
    const testOverride = config.overrides.find((override) =>
      Object.hasOwn(override.rules ?? {}, "vitest/no-focused-tests"),
    );

    expect(severity(testOverride?.rules?.["vitest/no-focused-tests"])).toBe(
      "error",
    );
    expect(severity(testOverride?.rules?.["vitest/no-disabled-tests"])).toBe(
      "error",
    );
    expect(
      severity(testOverride?.rules?.["vitest/no-conditional-expect"]),
    ).toBe("error");
  });
});
