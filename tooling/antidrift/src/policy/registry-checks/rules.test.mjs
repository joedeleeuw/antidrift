import { describe, expect, it } from "vitest";

import { checkRuleRegistry } from "./rules.mjs";
import { touch, workspace } from "../../../test/support/registry-workspace.mjs";

describe("checkRuleRegistry", () => {
  it("accepts semantic fact and retirement records without maturity metadata", () => {
    const root = workspace();
    touch(root, "docs/retired-rule.md");
    const errors = [];

    checkRuleRegistry(
      {
        schemaVersion: 1,
        semanticFactKinds: {},
        retiredRules: {
          "antidrift/retired-rule": {
            status: "retired",
            reason: "The maintained owner covers this behavior.",
            referenceDoc: "docs/retired-rule.md",
          },
        },
      },
      root,
      errors
    );

    expect(errors).toEqual([]);
  });

  it("requires a retired status and reason for every retirement", () => {
    const errors = [];

    checkRuleRegistry(
      {
        schemaVersion: 1,
        retiredRules: {
          "antidrift/retired-rule": { status: "ready" },
        },
      },
      workspace(),
      errors
    );

    expect(errors).toContain(
      "policy/registries/rules.yaml retiredRules.antidrift/retired-rule.status must be retired."
    );
    expect(errors).toContain(
      "policy/registries/rules.yaml retiredRules.antidrift/retired-rule.reason must be a non-empty string."
    );
  });

  it("requires retirement reference documents inside the repository", () => {
    const errors = [];

    checkRuleRegistry(
      {
        schemaVersion: 1,
        retiredRules: {
          "antidrift/retired-rule": {
            status: "retired",
            reason: "Retired by owner request.",
            referenceDoc: "docs/missing.md",
          },
        },
      },
      workspace(),
      errors
    );

    expect(errors).toEqual([
      "policy/registries/rules.yaml retiredRules.antidrift/retired-rule.referenceDoc path does not exist: docs/missing.md",
    ]);
  });

  it("requires schema version 1", () => {
    const errors = [];

    checkRuleRegistry({ schemaVersion: 2 }, workspace(), errors);

    expect(errors).toEqual([
      "policy/registries/rules.yaml schemaVersion must be 1.",
    ]);
  });
});
