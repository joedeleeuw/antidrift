import { describe, expect, it } from "vitest";
import { checkRuleSurface } from "./check-rule-surface.mjs";

describe("checkRuleSurface", () => {
  it("requires exported custom rules to be configured and tested", () => {
    const messages = [];
    const ok = checkRuleSurface({
      pluginRules: {
        alpha: {},
        beta: {},
      },
      configs: [
        {
          rules: {
            "antidrift/alpha": "error",
            "antidrift/gamma": "error",
          },
        },
      ],
      testSource: 'ruleTester.run("alpha", rule("alpha"), { valid: [], invalid: [] });',
      corpusCases: [],
      report: (message) => messages.push(message),
    });

    expect(ok).toBe(false);
    expect(messages.join("\n")).toContain("configured but not exported: antidrift/gamma");
    expect(messages.join("\n")).toContain("exported but not configured: antidrift/beta");
    expect(messages.join("\n")).toContain("exported but not covered by RuleTester or corpus: antidrift/beta");
  });

  it("rejects blocking custom rules whose registry status is not mature enough", () => {
    const messages = [];
    const testSource = [
      'ruleTester.run("alpha", rule("alpha"), { valid: [], invalid: [] });',
      'ruleTester.run("beta", rule("beta"), { valid: [], invalid: [] });',
      'ruleTester.run("stable", rule("stable"), { valid: [], invalid: [] });',
    ].join("\n");
    const ok = checkRuleSurface({
      pluginRules: {
        alpha: {},
        beta: {},
        stable: {},
      },
      configs: [
        {
          rules: {
            "antidrift/alpha": "error",
            "antidrift/beta": "warn",
            "antidrift/stable": "error",
          },
        },
      ],
      testSource,
      corpusCases: [],
      ruleRegistry: {
        rules: {
          "antidrift/alpha": { status: "under-proven", signal: "TypeChecker" },
          "antidrift/beta": { status: "ready", signal: "heuristic" },
          "antidrift/stable": { status: "ready", signal: "TypeChecker" },
        },
      },
      report: (message) => messages.push(message),
    });

    expect(ok).toBe(false);
    expect(messages.join("\n")).toContain("blocking despite registry status under-proven: antidrift/alpha");
    expect(messages.join("\n")).toContain("blocking despite heuristic signal heuristic: antidrift/beta");
    expect(messages.join("\n")).not.toContain("antidrift/stable");
  });

  it("treats configured-off custom rules as registered but not blocking", () => {
    const messages = [];
    const ok = checkRuleSurface({
      pluginRules: {
        alpha: {},
      },
      configs: [
        {
          rules: {
            "antidrift/alpha": "off",
          },
        },
      ],
      testSource: 'ruleTester.run("alpha", rule("alpha"), { valid: [], invalid: [] });',
      corpusCases: [],
      ruleRegistry: {
        rules: {
          "antidrift/alpha": { status: "under-proven", signal: "TypeChecker" },
        },
      },
      report: (message) => messages.push(message),
    });

    expect(ok).toBe(true);
    expect(messages).toEqual([]);
  });
});
