import { describe, expect, it } from "vitest";

import {
  hasNullablePositionalTuple,
  nullableTupleSlots,
  tupleElementIsNullishSlot,
  tupleElementIsOptional,
  tupleElementTypeNode,
  typeNodeIncludesDirectNullish,
} from "./tuple-shape.mjs";

describe("tuple-shape nullable positional helpers", () => {
  it("classifies optional and nullish tuple slots without name hints", () => {
    const optional = {
      type: "TSNamedTupleMember",
      optional: true,
      elementType: { type: "TSNumberKeyword" },
    };
    const nullable = {
      type: "TSUnionType",
      types: [{ type: "TSStringKeyword" }, { type: "TSNullKeyword" }],
    };
    const nestedNullable = {
      type: "TSParenthesizedType",
      typeAnnotation: {
        type: "TSUnionType",
        types: [{ type: "TSTypeReference" }, { type: "TSUndefinedKeyword" }],
      },
    };
    const required = { type: "TSBooleanKeyword" };
    const tuple = {
      type: "TSTupleType",
      elementTypes: [optional, nullable, nestedNullable, required],
    };

    expect(tupleElementTypeNode(optional)).toEqual(optional.elementType);
    expect(tupleElementIsOptional(optional)).toBe(true);
    expect(typeNodeIncludesDirectNullish(nullable)).toBe(true);
    expect(typeNodeIncludesDirectNullish(required)).toBe(false);
    expect(tupleElementIsNullishSlot(required)).toBe(false);
    expect(nullableTupleSlots(tuple)).toEqual([
      optional,
      nullable,
      nestedNullable,
    ]);
    expect(hasNullablePositionalTuple(tuple)).toBe(true);
    expect(
      hasNullablePositionalTuple({ type: "TSTupleType", elementTypes: [required] }),
    ).toBe(false);
  });
});
