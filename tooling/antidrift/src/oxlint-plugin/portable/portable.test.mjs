import { afterAll, describe, expect, it } from "vitest";
import { portableCases } from "../../../test/portable-cases.mjs";
import { createPortableHarness } from "../../../test/support/portable-harness.mjs";

const harness = createPortableHarness();
afterAll(() => harness.dispose());
describe.each(portableCases)("portable $name", (entry) => {
  it("reports the prohibited behavior", () => {
    const messages = harness.lint(
      entry.name,
      entry.invalid,
      entry.filename,
      entry.options,
    );
    expect(
      messages.some((message) => message.fatal),
      JSON.stringify(messages),
    ).toBe(false);
    expect(messages.map((message) => message.ruleId)).toContain(
      `antidrift/${entry.name}`,
    );
  });
  it("accepts the owned behavior", () => {
    expect(
      harness.lint(
        entry.name,
        entry.valid,
        entry.validFilename ?? entry.filename,
        entry.validOptions ?? entry.options,
      ),
    ).toEqual([]);
  });
});
