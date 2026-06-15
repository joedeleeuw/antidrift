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
    expect(messages.join("\n")).toContain("exported but not covered by RuleTester: antidrift/beta");
    expect(messages.join("\n")).toContain("exported but not covered by corpus evidence: antidrift/beta");
  });

  it("requires exported custom rules to have both RuleTester and corpus coverage", () => {
    const messages = [];
    const ok = checkRuleSurface({
      pluginRules: {
        alpha: {},
        beta: {},
        gamma: {},
      },
      configs: [
        {
          rules: {
            "antidrift/alpha": "error",
            "antidrift/beta": "error",
            "antidrift/gamma": "error",
          },
        },
      ],
      testSource: [
        'ruleTester.run("alpha", rule("alpha"), { valid: [], invalid: [] });',
        'ruleTester.run("gamma", rule("gamma"), { valid: [], invalid: [] });',
      ].join("\n"),
      corpusCases: [
        { ruleId: "antidrift/beta" },
        { ruleId: "antidrift/gamma" },
      ],
      report: (message) => messages.push(message),
    });

    expect(ok).toBe(false);
    expect(messages.join("\n")).toContain(
      "exported but not covered by RuleTester: antidrift/beta",
    );
    expect(messages.join("\n")).toContain(
      "exported but not covered by corpus evidence: antidrift/alpha",
    );
    expect(messages.join("\n")).not.toContain("antidrift/gamma");
  });

  it("counts default external corpus cases as surface evidence", () => {
    const messages = [];
    const ok = checkRuleSurface({
      pluginRules: {
        "require-authz-check": {},
      },
      configs: [
        {
          rules: {
            "antidrift/require-authz-check": "error",
          },
        },
      ],
      testSource:
        'ruleTester.run("require-authz-check", rule("require-authz-check"), { valid: [], invalid: [] });',
      ruleRegistry: {
        rules: {
          "antidrift/require-authz-check": {
            status: "ready",
            signal: "AST plus registry authority facts",
          },
        },
      },
      report: (message) => messages.push(message),
    });

    expect(ok).toBe(true);
    expect(messages).toEqual([]);
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
      corpusCases: [
        { ruleId: "antidrift/alpha" },
        { ruleId: "antidrift/beta" },
        { ruleId: "antidrift/stable" },
      ],
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
      corpusCases: [{ ruleId: "antidrift/alpha" }],
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

  it("skips cleanly when run outside the self-hosted source layout", () => {
    const messages = [];
    const ok = checkRuleSurface({
      repoRoot: "not-the-antidrift-source-repo",
      configs: [],
      report: (message) => messages.push(message),
    });

    expect(ok).toBe(true);
    expect(messages.join("\n")).toContain("check-rule-surface skipped");
  });
});
