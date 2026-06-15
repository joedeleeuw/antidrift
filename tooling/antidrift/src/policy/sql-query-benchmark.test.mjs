import { describe, expect, it } from "vitest";

import { classifySqlParserServiceDelta } from "./sql-query-benchmark.mjs";

describe("classifySqlParserServiceDelta", () => {
  it("marks missing probe data as not applicable", () => {
    expect(classifySqlParserServiceDelta(null)).toBe("not-applicable");
  });

  it("keeps equivalent non-type-aware behavior separate from conservative inventory", () => {
    expect(
      classifySqlParserServiceDelta({
        parserErrors: 0,
        comparisonWithTypeAware: {
          extraWithoutTypeServices: [],
          missingWithoutTypeServices: [],
        },
      }),
    ).toBe("equivalent-without-parser-services");
  });

  it("classifies extra non-type-aware reports as conservative inventory", () => {
    expect(
      classifySqlParserServiceDelta({
        parserErrors: 0,
        comparisonWithTypeAware: {
          extraWithoutTypeServices: ["src/query.ts:10"],
          missingWithoutTypeServices: [],
        },
      }),
    ).toBe("conservative-inventory-without-parser-services");
  });

  it("treats missing non-type-aware reports as a blocking delta", () => {
    expect(
      classifySqlParserServiceDelta({
        parserErrors: 0,
        comparisonWithTypeAware: {
          extraWithoutTypeServices: [],
          missingWithoutTypeServices: ["src/query.ts:10"],
        },
      }),
    ).toBe("blocking-false-negative-without-parser-services");
  });

  it("keeps mixed parser-service deltas distinct from one-sided deltas", () => {
    expect(
      classifySqlParserServiceDelta({
        parserErrors: 0,
        comparisonWithTypeAware: {
          extraWithoutTypeServices: ["src/query.ts:10"],
          missingWithoutTypeServices: ["src/query.ts:20"],
        },
      }),
    ).toBe("mixed-parser-service-delta");
  });

  it("does not classify parser-error probes as signal", () => {
    expect(
      classifySqlParserServiceDelta({
        parserErrors: 1,
        comparisonWithTypeAware: {
          extraWithoutTypeServices: ["src/query.ts:10"],
          missingWithoutTypeServices: [],
        },
      }),
    ).toBe("parser-error");
  });
});
