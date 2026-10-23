import { afterAll, describe, expect, it } from "vitest";
import { directiveRuleCases } from "../../test/directive-rule-cases.mjs";
import { createOxlintRuleHarness } from "../../test/support/oxlint-rule-harness.mjs";

const harness = createOxlintRuleHarness();
afterAll(() => harness.dispose());
describe.each(directiveRuleCases)("directive rule $name", (entry) => {
  it("reports the prohibited behavior", () => {
    const messages = harness.lint(
      entry.name,
      entry.invalid,
      entry.filename,
      entry.options
    );
    expect(
      messages.some((message) => message.fatal),
      JSON.stringify(messages)
    ).toBe(false);
    expect(messages.map((message) => message.ruleId)).toContain(
      `antidrift/${entry.name}`
    );
  });
  it("accepts the owned behavior", () => {
    expect(
      harness.lint(
        entry.name,
        entry.valid,
        entry.validFilename ?? entry.filename,
        entry.validOptions ?? entry.options
      )
    ).toEqual([]);
  });
});
