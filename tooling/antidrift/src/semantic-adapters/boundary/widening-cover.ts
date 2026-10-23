import ts from "typescript";

import { isErrorType } from "../kernel/typescript-internals.ts";
import { boundaryObservations } from "./boundary-observations.ts";
import { TypeDifference } from "./type-difference.ts";

const PAIR_CAP = boundaryObservations.bounds.wideningCoverPairs.limit;

const TOP_FLAGS = ts.TypeFlags.Any | ts.TypeFlags.Unknown;

const OBJECT_SOURCE_FLAGS =
  ts.TypeFlags.Object | ts.TypeFlags.NonPrimitive | ts.TypeFlags.Intersection;

const UNDEFINED_FLAGS = ts.TypeFlags.Undefined | ts.TypeFlags.Void;

export type Coverage = "covered" | "uncovered" | "incomplete";

/**
 * How `any` reads on the compared side. A producer typed `any` (or an
 * unresolved import) has unknown provenance, so the comparison is incomplete.
 * A slot declared `any` admits every value, so it covers nothing narrower.
 */
export type CoverSide = "producer" | "slot";

type MemberView = { readonly type: ts.Type; readonly optional: boolean };

type ObjectView = {
  readonly member: (name: string) => MemberView | undefined;
  readonly members: () => ReadonlyArray<MemberView & { readonly name: string }>;
  readonly indexes: () => readonly ts.IndexInfo[];
};

export function allCovered<Member>(
  members: Iterable<Member>,
  evaluate: (member: Member) => Coverage
): Coverage {
  let incomplete = false;
  for (const member of members) {
    const coverage = evaluate(member);
    if (coverage === "uncovered") {
      return "uncovered";
    }
    incomplete ||= coverage === "incomplete";
  }
  return incomplete ? "incomplete" : "covered";
}

function anyCovered<Member>(
  members: Iterable<Member>,
  evaluate: (member: Member) => Coverage
): Coverage {
  let incomplete = false;
  for (const member of members) {
    const coverage = evaluate(member);
    if (coverage === "covered") {
      return "covered";
    }
    incomplete ||= coverage === "incomplete";
  }
  return incomplete ? "incomplete" : "uncovered";
}

/**
 * `{}` written as a type, or left by narrowing `unknown` to non-nullish: it
 * admits every non-nullish value, primitives included. An empty object
 * literal's own type does not, since the literal built an object.
 */
export function admitsPrimitives(type: ts.Type): boolean {
  return (
    (type.flags & ts.TypeFlags.Object) !== 0 &&
    ((type.objectFlags ?? 0) & ts.ObjectFlags.ObjectLiteral) === 0 &&
    type.getProperties().length === 0 &&
    !type.getStringIndexType() &&
    !type.getNumberIndexType() &&
    type.getCallSignatures().length === 0 &&
    type.getConstructSignatures().length === 0
  );
}

/** The flags a target must carry to admit a nullish source (`null`, or `undefined`/`void`); 0 for other sources. */
function nullishFlags(source: ts.Type): number {
  if ((source.flags & ts.TypeFlags.Null) !== 0) {
    return ts.TypeFlags.Null;
  }
  return (source.flags & UNDEFINED_FLAGS) === 0 ? 0 : UNDEFINED_FLAGS;
}

function isOptionalSymbol(symbol: ts.Symbol): boolean {
  return (symbol.flags & ts.SymbolFlags.Optional) !== 0;
}

/**
 * Structural coverage: every value of the source type is a value of the
 * target type. It extends TypeScript assignability with the implicit index
 * signature that TypeScript grants object literal types but not interfaces,
 * so an interface whose properties fit a record's value type is covered by
 * that record. An `any` nested where the target claims something is read
 * through the instance's side, never as a wildcard.
 */
export class WideningCover {
  readonly side: CoverSide;
  readonly #checker: ts.TypeChecker;
  readonly #decided = new Map<ts.Type, Map<ts.Type, Coverage>>();
  #pairs = 0;
  #capped = false;

  constructor(checker: ts.TypeChecker, side: CoverSide) {
    this.#checker = checker;
    this.side = side;
  }

  get capped(): boolean {
    return this.#capped;
  }

  covers(source: ts.Type, target: ts.Type): Coverage {
    const settled =
      this.#unresolvedOrTop(source, target) ??
      ((source.flags & ts.TypeFlags.Never) !== 0 || source === target
        ? "covered"
        : null);
    if (settled) {
      return settled;
    }
    const alternatives = target.isUnion() ? target.types : [target];
    if (admitsPrimitives(source)) {
      return alternatives.some(admitsPrimitives) ? "covered" : "uncovered";
    }
    const nullish = nullishFlags(source);
    if (nullish !== 0) {
      // Without strictNullChecks `undefined` is assignable to every type,
      // but the value still fails any recovery that does not name it.
      return alternatives.some((member) => (member.flags & nullish) !== 0)
        ? "covered"
        : "uncovered";
    }
    const known = this.#decided.get(source)?.get(target);
    if (known) {
      return known;
    }
    if (this.#pairs >= PAIR_CAP) {
      this.#capped = true;
      return "incomplete";
    }
    this.#pairs += 1;
    const targets = this.#decided.get(source) ?? new Map<ts.Type, Coverage>();
    this.#decided.set(source, targets);
    targets.set(target, "covered");
    const decided = this.#decide(source, target);
    targets.set(target, decided);
    return decided;
  }

  /**
   * Coverage of an object literal that spreads a value of `source` and then
   * sets the `overrides` keys itself.
   */
  coversSpread(
    source: ts.Type,
    overrides: ReadonlyMap<string, ts.Type>,
    target: ts.Type
  ): Coverage {
    const settled = this.#unresolvedOrTop(source, target);
    if (settled) {
      return settled;
    }
    if (source.isUnion()) {
      return allCovered(source.types, (member) =>
        this.coversSpread(member, overrides, target)
      );
    }
    if (target.isUnion()) {
      return anyCovered(target.types, (member) =>
        this.coversSpread(source, overrides, member)
      );
    }
    if (target.isIntersection()) {
      return allCovered(target.types, (member) =>
        this.coversSpread(source, overrides, member)
      );
    }
    if (
      (source.flags & OBJECT_SOURCE_FLAGS) === 0 ||
      (target.flags & ts.TypeFlags.Object) === 0
    ) {
      return "uncovered";
    }
    return new ViewCoverage(
      this,
      this.#checker,
      this.#spreadView(source, overrides)
    ).within(target);
  }

  #unresolvedOrTop(source: ts.Type, target: ts.Type): Coverage | null {
    if (isErrorType(source) || isErrorType(target)) {
      return "incomplete";
    }
    if ((target.flags & TOP_FLAGS) !== 0) {
      return "covered";
    }
    if ((source.flags & ts.TypeFlags.Any) !== 0) {
      return this.side === "producer" ? "incomplete" : "uncovered";
    }
    return null;
  }

  #decide(source: ts.Type, target: ts.Type): Coverage {
    const assignable = this.#assignable(source, target);
    if (assignable !== "uncovered") {
      return assignable;
    }
    if (source.isUnion()) {
      return allCovered(source.types, (member) => this.covers(member, target));
    }
    if (target.isUnion()) {
      return anyCovered(target.types, (member) => this.covers(source, member));
    }
    if (target.isIntersection()) {
      return allCovered(target.types, (member) => this.covers(source, member));
    }
    if ((source.flags & ts.TypeFlags.TypeParameter) !== 0) {
      const constraint = this.#checker.getBaseConstraintOfType(source);
      return constraint && constraint !== source
        ? this.covers(constraint, target)
        : "uncovered";
    }
    if (this.#checker.isArrayLikeType(target)) {
      return this.#elements(source, target);
    }
    if (
      (source.flags & OBJECT_SOURCE_FLAGS) !== 0 &&
      (target.flags & ts.TypeFlags.Object) !== 0
    ) {
      return new ViewCoverage(
        this,
        this.#checker,
        this.#typeView(source)
      ).within(target);
    }
    return "uncovered";
  }

  #elements(source: ts.Type, target: ts.Type): Coverage {
    const checker = this.#checker;
    const targetElement = checker.getIndexTypeOfType(
      target,
      ts.IndexKind.Number
    );
    if (
      !targetElement ||
      checker.isTupleType(target) ||
      !checker.isArrayLikeType(source)
    ) {
      return "uncovered";
    }
    const sourceElements = checker.isTupleType(source)
      ? checker.getTypeArguments(source)
      : [checker.getIndexTypeOfType(source, ts.IndexKind.Number)];
    return allCovered(sourceElements, (element) =>
      element ? this.covers(element, targetElement) : "uncovered"
    );
  }

  #assignable(source: ts.Type, target: ts.Type): Coverage {
    if (!this.#checker.isTypeAssignableTo(source, target)) {
      return "uncovered";
    }
    const difference = new TypeDifference(this.#checker);
    const wildcard = difference.differs(source, target);
    if (difference.capped) {
      return "incomplete";
    }
    if (!wildcard) {
      return "covered";
    }
    return this.side === "producer" ? "incomplete" : "uncovered";
  }

  #typeView(source: ts.Type): ObjectView {
    const checker = this.#checker;
    const read = (symbol: ts.Symbol): MemberView => ({
      type: checker.getTypeOfSymbol(symbol),
      optional: isOptionalSymbol(symbol),
    });
    return {
      member: (name) => {
        const symbol = checker.getPropertyOfType(source, name);
        return symbol ? read(symbol) : undefined;
      },
      members: () =>
        checker
          .getPropertiesOfType(source)
          .map((symbol) => ({ name: symbol.name, ...read(symbol) })),
      indexes: () => checker.getIndexInfosOfType(source),
    };
  }

  #spreadView(
    source: ts.Type,
    overrides: ReadonlyMap<string, ts.Type>
  ): ObjectView {
    const base = this.#typeView(source);
    const overridden = (name: string): MemberView | undefined => {
      const type = overrides.get(name);
      return type ? { type, optional: false } : undefined;
    };
    return {
      member: (name) => overridden(name) ?? base.member(name),
      members: () => [
        ...base.members().filter((member) => !overrides.has(member.name)),
        ...[...overrides].map(([name, type]) => ({
          name,
          type,
          optional: false,
        })),
      ],
      indexes: base.indexes,
    };
  }
}

/** Compares one object's members with a target object type, property by property and index by index. */
class ViewCoverage {
  readonly #cover: WideningCover;
  readonly #checker: ts.TypeChecker;
  readonly #view: ObjectView;

  constructor(cover: WideningCover, checker: ts.TypeChecker, view: ObjectView) {
    this.#cover = cover;
    this.#checker = checker;
    this.#view = view;
  }

  within(target: ts.Type): Coverage {
    const checker = this.#checker;
    if (
      target.getCallSignatures().length > 0 ||
      target.getConstructSignatures().length > 0
    ) {
      return "uncovered";
    }
    const targetProperties = checker.getPropertiesOfType(target);
    if (this.#sharesNothingWithWeak(target, targetProperties)) {
      return "uncovered";
    }
    const properties = allCovered(targetProperties, (property) =>
      this.#property(property)
    );
    if (properties === "uncovered") {
      return properties;
    }
    const indexes = allCovered(checker.getIndexInfosOfType(target), (index) =>
      this.#index(index)
    );
    return allCovered([properties, indexes], (coverage) => coverage);
  }

  /**
   * TypeScript's weak-type rule: a target whose properties are all optional
   * covers no source that has properties but shares none of them, so a cast
   * to `{ rowCount?: number }` is not passed vacuously.
   */
  #sharesNothingWithWeak(
    target: ts.Type,
    targetProperties: readonly ts.Symbol[]
  ): boolean {
    return (
      targetProperties.length > 0 &&
      targetProperties.every(isOptionalSymbol) &&
      this.#checker.getIndexInfosOfType(target).length === 0 &&
      this.#view.members().length > 0 &&
      !targetProperties.some((property) => this.#view.member(property.name))
    );
  }

  #property(property: ts.Symbol): Coverage {
    const sourceMember = this.#view.member(property.name);
    const optionalTarget = isOptionalSymbol(property);
    if (!sourceMember) {
      return optionalTarget ? "covered" : "uncovered";
    }
    if (sourceMember.optional && !optionalTarget) {
      return "uncovered";
    }
    return this.#cover.covers(
      sourceMember.type,
      this.#checker.getTypeOfSymbol(property)
    );
  }

  #index(index: ts.IndexInfo): Coverage {
    const members = allCovered(
      this.#view.members().filter((member) => this.#keyed(member.name, index)),
      (member) => this.#cover.covers(member.type, index.type)
    );
    if (members === "uncovered") {
      return members;
    }
    const indexes = allCovered(
      this.#view
        .indexes()
        .filter((sourceIndex) =>
          this.#overlaps(sourceIndex.keyType, index.keyType)
        ),
      (sourceIndex) => this.#cover.covers(sourceIndex.type, index.type)
    );
    return allCovered([members, indexes], (coverage) => coverage);
  }

  #keyed(name: string, index: ts.IndexInfo): boolean {
    const checker = this.#checker;
    if (name.startsWith("__@")) {
      return (index.keyType.flags & ts.TypeFlags.ESSymbolLike) !== 0;
    }
    if ((index.keyType.flags & ts.TypeFlags.String) !== 0) {
      return true;
    }
    const numeric = Number(name);
    const keyType =
      name.trim() !== "" && Number.isFinite(numeric)
        ? checker.getNumberLiteralType(numeric)
        : checker.getStringLiteralType(name);
    return checker.isTypeAssignableTo(keyType, index.keyType);
  }

  #overlaps(sourceKey: ts.Type, targetKey: ts.Type): boolean {
    return (
      this.#checker.isTypeAssignableTo(sourceKey, targetKey) ||
      this.#checker.isTypeAssignableTo(targetKey, sourceKey)
    );
  }
}
