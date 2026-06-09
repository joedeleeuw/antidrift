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

    expect(severity(rules["@typescript-eslint/no-misused-promises"])).toBe("error");
    expect(severity(rules["@typescript-eslint/no-unnecessary-condition"])).toBe("error");
    expect(severity(rules["@typescript-eslint/consistent-type-imports"])).toBe("error");
    expect(severity(rules["@typescript-eslint/no-unsafe-type-assertion"])).toBe("error");
    expect(severity(rules["@typescript-eslint/no-import-type-side-effects"])).toBe("error");
    expect(severity(rules["@typescript-eslint/no-misused-spread"])).toBe("error");
    expect(severity(rules["@typescript-eslint/sort-type-constituents"])).toBe("error");
    expect(severity(rules["react/button-has-type"])).toBe("error");
    expect(severity(rules["react/function-component-definition"])).toBe("error");
    expect(severity(rules["react/jsx-filename-extension"])).toBe("error");
    expect(severity(rules["react/jsx-pascal-case"])).toBe("error");
    expect(severity(rules["react/jsx-no-script-url"])).toBe("error");
    expect(severity(rules["react/no-array-index-key"])).toBe("error");
    expect(severity(rules["react/no-deprecated"])).toBe("error");
    expect(severity(rules["react/no-is-mounted"])).toBe("error");
    expect(severity(rules["react/no-unescaped-entities"])).toBe("error");
    expect(severity(rules["react/jsx-sort-props"])).toBe("error");
    expect(severity(rules["unicorn/catch-error-name"])).toBe("error");
    expect(severity(rules["unicorn/consistent-function-scoping"])).toBe("error");
    expect(severity(rules["unicorn/no-instanceof-builtins"])).toBe("error");
    expect(severity(rules["unicorn/no-new-buffer"])).toBe("error");
    expect(severity(rules["unicorn/no-unnecessary-polyfills"])).toBe("error");
    expect(severity(rules["unicorn/prefer-regexp-test"])).toBe("error");
    expect(severity(rules["sonarjs/no-unsafe-unzip"])).toBe("error");
    expect(severity(rules["no-multiple-empty-lines"])).toBe("error");
    expect(severity(rules["sort-imports"])).toBe("error");
    expect(severity(rules["@eslint-community/eslint-comments/no-unlimited-disable"])).toBe("error");
    expect(severity(rules["import-x/consistent-type-specifier-style"])).toBe("error");
    expect(severity(rules["import-x/export"])).toBe("error");
    expect(severity(rules["import-x/first"])).toBe("error");
    expect(severity(rules["import-x/newline-after-import"])).toBe("error");
    expect(severity(rules["import-x/no-absolute-path"])).toBe("error");
    expect(severity(rules["import-x/no-duplicates"])).toBe("error");
    expect(severity(rules["import-x/no-extraneous-dependencies"])).toBe("error");
    expect(severity(rules["import-x/no-self-import"])).toBe("error");
    expect(severity(rules["import-x/no-useless-path-segments"])).toBe("error");
    expect(severity(rules["import-x/order"])).toBe("error");
  });
});
