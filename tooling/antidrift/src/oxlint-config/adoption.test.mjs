import { describe, expect, it } from "vitest";
import {
  antidriftAdoptionPresets,
  createAdoptionOxlintConfig,
} from "./adoption.mjs";
import selection from "../../test/corpus/native-selection.json" with { type: "json" };

describe("named native adoption presets", () => {
  it("composes every eligible native rule at error severity", () => {
    const config = createAdoptionOxlintConfig({
      presets: Object.keys(antidriftAdoptionPresets),
    });
    expect(Object.keys(config.rules).sort()).toEqual(
      selection.rules.map((row) => row.id).sort(),
    );
    expect(Object.keys(config.rules)).toHaveLength(436);
    expect(
      Object.values(config.rules).every(
        (value) => (Array.isArray(value) ? value[0] : value) === "error",
      ),
    ).toBe(true);
    expect(config.plugins).not.toContain("nextjs");
  });
  it("keeps selection explicit and rejects misspelled owners", () => {
    expect(() => createAdoptionOxlintConfig({ presets: [] })).toThrow(
      "Select at least one",
    );
    expect(() => createAdoptionOxlintConfig({ presets: ["nextjs"] })).toThrow(
      "Unknown adoption preset",
    );
    expect(
      Object.keys(createAdoptionOxlintConfig({ presets: ["node"] }).rules),
    ).toEqual(Object.keys(antidriftAdoptionPresets.node));
  });
});
