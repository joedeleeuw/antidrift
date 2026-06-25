import { describe, expect, it } from "vitest";

import { checkRuleSurface } from "./check-rule-surface.mjs";

describe("checkRuleSurface", () => {
  it("requires exported custom rules to be configured and corpus covered", () => {
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
      corpusCases: [],
      report: (message) => messages.push(message),
    });

    expect(ok).toBe(false);
    expect(messages.join("\n")).toContain("configured but not exported: antidrift/gamma");
    expect(messages.join("\n")).toContain("exported but not configured: antidrift/beta");
    expect(messages.join("\n")).toContain("exported but not covered by corpus evidence: antidrift/beta");
  });

  it("does not promote RuleTester source shape to a required surface", () => {
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
            "antidrift/beta": "error",
          },
        },
      ],
      corpusCases: [
        { ruleId: "antidrift/alpha" },
        { ruleId: "antidrift/beta" },
      ],
      report: (message) => messages.push(message),
    });

    expect(ok).toBe(true);
    expect(messages).toEqual([]);
      });

  it("counts default external corpus cases as surface evidence", () => {
    const messages = [];
    const ok = checkRuleSurface({
      pluginRules: {
        "no-trivial-selector-wrapper": {},
      },
      configs: [
        {
          rules: {
            "antidrift/no-trivial-selector-wrapper": "error",
          },
        },
      ],
      ruleRegistry: {
        rules: {
          "antidrift/no-trivial-selector-wrapper": {
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
    const ok = checkRuleSurface({
      pluginRules: {
        alpha: {},
        beta: {},
        retired: {},
        stable: {},
      },
      configs: [
        {
          rules: {
            "antidrift/alpha": "error",
            "antidrift/beta": "warn",
            "antidrift/retired": "error",
            "antidrift/stable": "error",
          },
        },
      ],
      corpusCases: [
        { ruleId: "antidrift/alpha" },
        { ruleId: "antidrift/beta" },
        { ruleId: "antidrift/retired" },
        { ruleId: "antidrift/stable" },
      ],
      ruleRegistry: {
        rules: {
          "antidrift/alpha": { status: "under-proven", signal: "TypeChecker" },
          "antidrift/beta": { status: "ready", signal: "heuristic" },
          "antidrift/retired": { status: "retired", signal: "no-op stub" },
          "antidrift/stable": { status: "ready", signal: "TypeChecker" },
        },
      },
      report: (message) => messages.push(message),
    });

    expect(ok).toBe(false);
    expect(messages.join("\n")).toContain("blocking despite registry status under-proven: antidrift/alpha");
    expect(messages.join("\n")).toContain("blocking despite registry status retired: antidrift/retired");
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

  it("rejects default-off custom rules with nonzero severity", () => {
    const messages = [];
    const ok = checkRuleSurface({
      pluginRules: {
        alpha: {},
      },
      configs: [
        {
          rules: {
            "antidrift/alpha": "warn",
          },
        },
      ],
      corpusCases: [{ ruleId: "antidrift/alpha" }],
      ruleRegistry: {
        rules: {
          "antidrift/alpha": {
            status: "ready",
            defaultOff: true,
            signal: "TypeChecker",
          },
        },
      },
      report: (message) => messages.push(message),
    });

    expect(ok).toBe(false);
    expect(messages.join("\n")).toContain(
      "configured as blocking despite defaultOff metadata: antidrift/alpha",
    );
  });

  it("fails when the runtime config surface is missing instead of skipping missing source layout", () => {
    const messages = [];
    const ok = checkRuleSurface({
      repoRoot: "not-the-antidrift-source-repo",
      pluginRules: {
        alpha: {},
      },
      configs: [],
      corpusCases: [{ ruleId: "antidrift/alpha" }],
      ruleRegistry: {},
      report: (message) => messages.push(message),
    });

    expect(ok).toBe(false);
    expect(messages.join("\n")).toContain("Custom rule exported but not configured: antidrift/alpha");
  });

  it("throws when the self-hosted registry is missing", () => {
    expect(() =>
      checkRuleSurface({
        repoRoot: "not-the-antidrift-source-repo",
        pluginRules: {},
        configs: [],
        corpusCases: [],
      }),
    ).toThrow(/rules\.yaml/u);
  });
});
