import { describe, expect, it } from "vitest";

import { eslintCorpusRuleIds, repoCorpusDecision } from "./repo-corpus.mjs";

describe("repoCorpusDecision", () => {
  it("uses the ESLint-owned custom rule surface", () => {
    expect(
      eslintCorpusRuleIds({
        eslintRules: {
          "typed-rule": {},
        },
      })
    ).toEqual(["antidrift/typed-rule"]);
  });

  it("fails when selected rules do not activate", () => {
    expect(
      repoCorpusDecision({
        findings: [],
        inactiveRules: ["antidrift/configured-rule"],
      })
    ).toBe("fail");
    expect(repoCorpusDecision({ findings: [], inactiveRules: [] })).toBe(
      "pass"
    );
  });

  it("keeps error findings blocking when no rules are inactive", () => {
    const decision = repoCorpusDecision({
      findings: [{ severity: "error" }],
      inactiveRules: [],
    });

    expect(decision).toBe("fail");
  });
});
