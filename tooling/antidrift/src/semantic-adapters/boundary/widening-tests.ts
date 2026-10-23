import ts from "typescript";

import { isErrorType } from "../kernel/typescript-internals.ts";
import { admitsPrimitives, allCovered } from "./widening-cover.ts";
import type { Coverage, WideningCover } from "./widening-cover.ts";

/** What a recovery re-establishes, read as a test every value of a type must pass. */
export type RecoveryTest = {
  /** What the recovery re-establishes, as the message shows it. */
  readonly restores: string;
  /** Whether every value of `type` passes the recovery, reading `any` per the cover's side. */
  readonly admits: (type: ts.Type, cover: WideningCover) => Coverage;
  /** The re-established type, for recoveries that name one. */
  readonly target: ts.Type | null;
  /** The key a discriminant recovery compares, with the compared literal. */
  readonly discriminant: {
    readonly key: string;
    readonly literal: ts.Type;
  } | null;
};

type TagMatcher = (type: ts.Type) => boolean;

const OBJECT_FLAGS = ts.TypeFlags.Object | ts.TypeFlags.NonPrimitive;

const PRIMITIVE_FLAGS =
  ts.TypeFlags.StringLike |
  ts.TypeFlags.NumberLike |
  ts.TypeFlags.BigIntLike |
  ts.TypeFlags.BooleanLike |
  ts.TypeFlags.ESSymbolLike |
  ts.TypeFlags.Null |
  ts.TypeFlags.Undefined |
  ts.TypeFlags.Void;

function callable(type: ts.Type): boolean {
  return (
    type.getCallSignatures().length > 0 ||
    type.getConstructSignatures().length > 0
  );
}

function primitivePart(type: ts.Type): ts.Type | undefined {
  return type.isIntersection()
    ? type.types.find((member) => (member.flags & PRIMITIVE_FLAGS) !== 0)
    : undefined;
}

function flagMatcher(flags: ts.TypeFlags): TagMatcher {
  return (type) => ((primitivePart(type) ?? type).flags & flags) !== 0;
}

const TYPEOF_TAGS: ReadonlyMap<string, TagMatcher> = new Map([
  ["string", flagMatcher(ts.TypeFlags.StringLike)],
  ["number", flagMatcher(ts.TypeFlags.NumberLike)],
  ["bigint", flagMatcher(ts.TypeFlags.BigIntLike)],
  ["boolean", flagMatcher(ts.TypeFlags.BooleanLike)],
  ["symbol", flagMatcher(ts.TypeFlags.ESSymbolLike)],
  [
    "object",
    (type) =>
      (type.flags & ts.TypeFlags.Null) !== 0 ||
      (!primitivePart(type) &&
        (type.flags & (OBJECT_FLAGS | ts.TypeFlags.Intersection)) !== 0 &&
        !callable(type) &&
        !admitsPrimitives(type)),
  ],
  [
    "function",
    (type) =>
      (type.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection)) !== 0 &&
      callable(type),
  ],
]);

export function typeofTagMatches(tag: string, type: ts.Type): boolean {
  return TYPEOF_TAGS.get(tag)?.(type) ?? false;
}

/** Builds the test each recovery kind re-establishes. */
export class RecoveryTests {
  readonly #checker: ts.TypeChecker;

  constructor(checker: ts.TypeChecker) {
    this.#checker = checker;
  }

  /** An assertion, a type predicate, an `instanceof` or a forwarding slot: the type itself. */
  type(target: ts.Type): RecoveryTest {
    return {
      restores: `\`${this.#checker.typeToString(target)}\``,
      admits: (type, cover) => cover.covers(type, target),
      target,
      discriminant: null,
    };
  }

  /** A `typeof` comparison with `tag`. */
  tag(tag: string): RecoveryTest | null {
    const matches = TYPEOF_TAGS.get(tag);
    if (!matches) {
      return null;
    }
    return {
      restores: `\`${tag}\``,
      admits: this.#memberwise((member) =>
        matches(member) ? "covered" : "uncovered"
      ),
      target: null,
      discriminant: null,
    };
  }

  /** An `in` check for `key`: every member must declare it as required. */
  key(key: string): RecoveryTest {
    const checker = this.#checker;
    return {
      restores: `the \`${key}\` key`,
      admits: this.#memberwise((member) => {
        const property = checker.getPropertyOfType(member, key);
        return property && (property.flags & ts.SymbolFlags.Optional) === 0
          ? "covered"
          : "uncovered";
      }),
      target: null,
      discriminant: null,
    };
  }

  /** A comparison of `key` with a literal: every member's `key` must be that literal. */
  discriminant(key: string, literal: ts.Type): RecoveryTest {
    const checker = this.#checker;
    return {
      restores: `\`${key}: ${checker.typeToString(literal)}\``,
      admits: this.#memberwise((member, cover) => {
        const property = checker.getPropertyOfType(member, key);
        return property
          ? cover.covers(checker.getTypeOfSymbol(property), literal)
          : "uncovered";
      }),
      target: null,
      discriminant: { key, literal },
    };
  }

  #memberwise(
    decide: (member: ts.Type, cover: WideningCover) => Coverage
  ): RecoveryTest["admits"] {
    const checker = this.#checker;
    const admits: RecoveryTest["admits"] = (type, cover) =>
      allCovered(type.isUnion() ? type.types : [type], (member) => {
        if (isErrorType(member)) {
          return "incomplete";
        }
        if ((member.flags & ts.TypeFlags.Any) !== 0) {
          return cover.side === "producer" ? "incomplete" : "uncovered";
        }
        if ((member.flags & ts.TypeFlags.Never) !== 0) {
          return "covered";
        }
        if ((member.flags & ts.TypeFlags.TypeParameter) !== 0) {
          const constraint = checker.getBaseConstraintOfType(member);
          return constraint && constraint !== member
            ? admits(constraint, cover)
            : "uncovered";
        }
        return (member.flags & ts.TypeFlags.Unknown) !== 0
          ? "uncovered"
          : decide(member, cover);
      });
    return admits;
  }
}
