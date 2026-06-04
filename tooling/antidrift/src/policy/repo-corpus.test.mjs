import { describe, expect, it } from "vitest";
import { allowedInactiveRulesFromRegistry, repoCorpusDecision } from "./repo-corpus.mjs";

describe("repoCorpusDecision", () => {
  it("allows inactive rules only when their registry maturity forbids blocking enforcement", () => {
    const allowedInactiveRules = allowedInactiveRulesFromRegistry({
      rules: {
        "antidrift/under-proven": { status: "under-proven", signal: "TypeChecker" },
        "antidrift/heuristic": { status: "ready", signal: "token-overlap" },
        "antidrift/stable": { status: "ready", signal: "TypeChecker" },
      },
    });

    expect([...allowedInactiveRules].sort((a, b) => a.localeCompare(b))).toEqual(["antidrift/heuristic", "antidrift/under-proven"]);
    expect(repoCorpusDecision({ findings: [], inactiveRules: ["antidrift/under-proven"], allowedInactiveRules })).toBe("pass");
    expect(repoCorpusDecision({ findings: [], inactiveRules: ["antidrift/stable"], allowedInactiveRules })).toBe("fail");
  });

  it("keeps error findings blocking even when inactive rules are allowed", () => {
    const decision = repoCorpusDecision({
      findings: [{ severity: "error" }],
      inactiveRules: ["antidrift/under-proven"],
      allowedInactiveRules: new Set(["antidrift/under-proven"]),
    });

    expect(decision).toBe("fail");
  });
});
