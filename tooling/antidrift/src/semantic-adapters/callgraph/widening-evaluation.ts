import ts from "typescript";

import { allCovered, WideningCover } from "../boundary/widening-cover.ts";
import type { Coverage } from "../boundary/widening-cover.ts";
import type { Guard, PathProjection } from "../boundary/widening-paths.ts";
import type { Recovery } from "../boundary/widening-recoveries.ts";
import type { Origin, Step } from "../boundary/widening-trace.ts";
import { typeContainsCompilerError } from "../provenance/type-resolution-provenance.ts";
import type { Producer } from "./widening-producers.ts";

export type Candidate = {
  readonly recovery: Recovery;
  readonly origin: Origin;
};

const NULLISH_FLAGS =
  ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void;

/** Whether two steps may reach the same value: a computed key may be any key. */
function aligned(left: Step | undefined, right: Step | undefined): boolean {
  if (!left || !right) {
    return false;
  }
  if (left.kind === "element" || right.kind === "element") {
    return left.kind !== "await" && right.kind !== "await";
  }
  if (left.kind === "member" && right.kind === "member") {
    return left.key === right.key;
  }
  return left.kind === right.kind;
}

/** Where a producer lands relative to the recovered path: on or above it, inside it, or beside it. */
function placement(
  producerPath: readonly Step[],
  recoveredPath: readonly Step[]
): "within" | "inside" | "apart" {
  const shared = Math.min(producerPath.length, recoveredPath.length);
  for (let index = 0; index < shared; index += 1) {
    if (!aligned(producerPath[index], recoveredPath[index])) {
      return "apart";
    }
  }
  return producerPath.length <= recoveredPath.length ? "within" : "inside";
}

/**
 * Decides one recovery of one slot: whether it narrows what the slot's type
 * admits at the recovered value, and whether every producer already passes it.
 */
export class CandidateEvaluation {
  readonly #checker: ts.TypeChecker;
  readonly #paths: PathProjection;
  readonly #candidate: Candidate;
  readonly #slotCover: WideningCover;
  readonly #producerCover: WideningCover;

  constructor(
    checker: ts.TypeChecker,
    paths: PathProjection,
    candidate: Candidate
  ) {
    this.#checker = checker;
    this.#paths = paths;
    this.#candidate = candidate;
    this.#slotCover = new WideningCover(checker, "slot");
    this.#producerCover = new WideningCover(checker, "producer");
  }

  get capped(): boolean {
    return this.#slotCover.capped || this.#producerCover.capped;
  }

  /**
   * "uncovered" when the recovery excludes something the slot's type admits
   * at the recovered value, both as TypeScript narrows the operand there and
   * as the guards that filter the producers filter the declared type. A
   * recovery that only removes null or undefined reads as "covered": nullish
   * checks are not recoveries in this version.
   */
  slotNarrowing(guards: readonly Guard[]): Coverage {
    const { recovery, origin } = this.#candidate;
    const { target } = recovery.test;
    if (target && typeContainsCompilerError(this.#checker, target)) {
      return "incomplete";
    }
    const slotType = this.#checker.getTypeAtLocation(recovery.operand);
    const narrows = recovery.test.admits(slotType, this.#slotCover);
    if (narrows !== "uncovered") {
      return narrows;
    }
    const nullish =
      slotType.isUnion() &&
      slotType.types.some((member) => (member.flags & NULLISH_FLAGS) !== 0);
    const flow = nullish
      ? recovery.test.admits(slotType.getNonNullableType(), this.#slotCover)
      : narrows;
    if (flow !== "uncovered" || origin.overrides.size > 0) {
      return flow;
    }
    return allCovered(
      this.#paths.project(origin.slot.declared, origin.path, guards),
      (member) =>
        (member.flags & NULLISH_FLAGS) === 0
          ? recovery.test.admits(member, this.#slotCover)
          : "covered"
    );
  }

  /**
   * A producer whose values never reach the recovered value (an empty array,
   * or members the guards exclude) passes vacuously; when none reaches it,
   * nothing re-derives a producer's type and the recovery is not a round trip.
   */
  producersPass(
    producers: readonly Producer[],
    guards: readonly Guard[]
  ): Coverage {
    const { origin } = this.#candidate;
    const reaching: Array<readonly ts.Type[]> = [];
    const writes: Producer[] = [];
    for (const producer of producers) {
      const landing = placement(producer.path, origin.path);
      if (landing === "within") {
        reaching.push(
          this.#paths.project(
            producer.type,
            origin.path.slice(producer.path.length),
            guards.flatMap((guard) =>
              placement(producer.path, guard.path) === "within"
                ? [{ ...guard, path: guard.path.slice(producer.path.length) }]
                : []
            )
          )
        );
      } else if (landing === "inside") {
        writes.push(producer);
      }
    }
    for (const contribution of origin.contributions) {
      reaching.push(
        this.#paths.project(
          this.#checker.getTypeAtLocation(contribution.expression),
          contribution.path,
          []
        )
      );
    }
    const supplied = reaching.filter((projected) => projected.length > 0);
    if (supplied.length === 0) {
      return "uncovered";
    }
    const passes = this.#producerTest();
    return allCovered(
      [
        ...supplied.map((projected) => () => allCovered(projected, passes)),
        ...writes.map((producer) => () => this.#writeFits(producer)),
      ],
      (check) => check()
    );
  }

  /**
   * The test each producer member must pass: the recovery itself, or, when
   * the recovered value spreads the slot and sets keys of its own, the copy
   * against the recovered type.
   */
  #producerTest(): (member: ts.Type) => Coverage {
    const { recovery, origin } = this.#candidate;
    const cover = this.#producerCover;
    if (origin.overrides.size === 0) {
      return (member) => recovery.test.admits(member, cover);
    }
    const target = recovery.test.target;
    if (!target) {
      return () => "incomplete";
    }
    const overrides = new Map(
      [...origin.overrides].map(([key, expression]) => [
        key,
        this.#checker.getTypeAtLocation(expression),
      ])
    );
    return (member) => cover.coversSpread(member, overrides, target);
  }

  /** A write that lands inside the recovered value must fit what the recovery demands there. */
  #writeFits(producer: Producer): Coverage {
    const { recovery, origin } = this.#candidate;
    const rest = producer.path.slice(origin.path.length);
    const { target, discriminant } = recovery.test;
    const cover = this.#producerCover;
    if (target) {
      const demanded = this.#paths.demandedAt(target, rest);
      return demanded.length === 0 ||
        demanded.some((type) => cover.covers(producer.type, type) === "covered")
        ? "covered"
        : "uncovered";
    }
    const [first] = rest;
    return discriminant &&
      rest.length === 1 &&
      first?.kind === "member" &&
      first.key === discriminant.key
      ? cover.covers(producer.type, discriminant.literal)
      : "covered";
  }
}
