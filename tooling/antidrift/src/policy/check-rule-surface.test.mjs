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
});
