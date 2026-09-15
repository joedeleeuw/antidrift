import { describe, expect, it } from "vitest";

import { checkRuleSurface } from "./check-rule-surface.mjs";

describe("checkRuleSurface", () => {
  it("requires exported custom rules to be configured", () => {
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
      report: (message) => messages.push(message),
    });

    expect(ok).toBe(false);
    expect(messages.join("\n")).toContain(
      "configured but not exported: antidrift/gamma",
    );
    expect(messages.join("\n")).toContain(
      "exported but not configured: antidrift/beta",
    );
  });

  it("does not couple rule ownership to a separate corpus manifest", () => {
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
      report: (message) => messages.push(message),
    });

    expect(ok).toBe(true);
    expect(messages).toEqual([]);
  });

  it("rejects custom rules enabled by more than one runtime", () => {
    const messages = [];
    const ok = checkRuleSurface({
      pluginRules: {
        alpha: {},
      },
      configs: [
        {
          rules: {
            "antidrift/alpha": "error",
          },
        },
      ],
      runtimeConfigs: {
        eslint: [{ rules: { "antidrift/alpha": "error" } }],
        oxlint: [{ rules: { "antidrift/alpha": "error" } }],
      },
      ruleRegistry: {
        rules: {
          "antidrift/alpha": { status: "ready", signal: "AST" },
        },
      },
      report: (message) => messages.push(message),
    });

    expect(ok).toBe(false);
    expect(messages.join("\n")).toContain(
      "enabled by multiple runtimes: antidrift/alpha (eslint, oxlint)",
    );
  });

  it("allows dual export when only one runtime enables the rule", () => {
    const messages = [];
    const ok = checkRuleSurface({
      pluginRules: {
        alpha: {},
      },
      runtimePluginRules: {
        eslint: { alpha: {} },
        oxlint: { alpha: {} },
      },
      configs: [
        {
          rules: {
            "antidrift/alpha": "error",
          },
        },
      ],
      runtimeConfigs: {
        oxlint: [{ rules: { "antidrift/alpha": "error" } }],
        eslint: [{ rules: { "antidrift/alpha": "off" } }],
      },
      ruleRegistry: {
        rules: {
          "antidrift/alpha": { status: "ready", signal: "AST" },
        },
      },
      report: (message) => messages.push(message),
    });

    expect(messages).toEqual([]);
    expect(ok).toBe(true);
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
    expect(messages.join("\n")).toContain(
      "blocking despite registry status under-proven: antidrift/alpha",
    );
    expect(messages.join("\n")).toContain(
      "blocking despite registry status retired: antidrift/retired",
    );
    expect(messages.join("\n")).toContain(
      "blocking despite heuristic signal heuristic: antidrift/beta",
    );
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
      ruleRegistry: {},
      report: (message) => messages.push(message),
    });

    expect(ok).toBe(false);
    expect(messages.join("\n")).toContain(
      "Custom rule exported but not configured: antidrift/alpha",
    );
  });

  it("throws when the self-hosted registry is missing", () => {
    expect(() =>
      checkRuleSurface({
        repoRoot: "not-the-antidrift-source-repo",
        pluginRules: {},
        configs: [],
      }),
    ).toThrow(/rules\.yaml/u);
  });
});
