import { relative } from "node:path";
import ts from "typescript";

import { isTopType } from "../boundary/widening-recoveries.ts";
import type { Recovery } from "../boundary/widening-recoveries.ts";
import { pathText } from "../boundary/widening-trace.ts";
import type { Origin, Slot } from "../boundary/widening-trace.ts";
import type { Producer } from "./widening-producers.ts";

/** Where a slot's contract is declared, which decides where the finding is anchored. */
export type Owner =
  | { readonly kind: "local" }
  | { readonly kind: "elsewhere"; readonly location: string }
  | { readonly kind: "third-party" };

const TYPE_TEXT_LENGTH = 60;

const LISTED_KEYS = 3;

function lineOf(node: ts.Node): number {
  const sourceFile = node.getSourceFile();
  return (
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
  );
}

function quotedList(names: readonly string[]): string {
  const shown = names.slice(0, LISTED_KEYS).map((name) => `\`${name}\``);
  const rest = names.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
}

/** Builds the finding message: what the producers are, what the contract drops, and what re-establishes it. */
export class WideningMessage {
  readonly #program: ts.Program;
  readonly #checker: ts.TypeChecker;
  readonly #cwd: string;

  constructor(program: ts.Program, checker: ts.TypeChecker, cwd: string) {
    this.#program = program;
    this.#checker = checker;
    this.#cwd = cwd;
  }

  owner(slot: Slot): Owner {
    const contract = slot.contract;
    if (!ts.isTypeReferenceNode(contract)) {
      return { kind: "local" };
    }
    let symbol = this.#checker.getSymbolAtLocation(contract.typeName);
    if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
      symbol = this.#checker.getAliasedSymbol(symbol);
    }
    const sourceFile = symbol?.declarations?.[0]?.getSourceFile();
    if (
      !sourceFile ||
      this.#program.isSourceFileDefaultLibrary(sourceFile) ||
      sourceFile === slot.declaration.getSourceFile()
    ) {
      return { kind: "local" };
    }
    if (
      this.#program.isSourceFileFromExternalLibrary(sourceFile) ||
      sourceFile.fileName.includes("/node_modules/")
    ) {
      return { kind: "third-party" };
    }
    return {
      kind: "elsewhere",
      location: relative(this.#cwd, sourceFile.fileName),
    };
  }

  data(
    slot: Slot,
    recovery: Recovery,
    origin: Origin,
    producers: readonly Producer[],
    owner: Owner
  ): Readonly<Record<string, string>> {
    const [whole] = producers.filter((producer) => producer.path.length === 0);
    const shown = whole ?? producers[0];
    const others = producers.length - 1;
    const contract = this.#display(slot.declared);
    return {
      subject: slot.subject,
      producer: shown ? this.#display(shown.type) : "",
      others:
        others > 0
          ? ` and ${others} other producer${others === 1 ? "" : "s"}`
          : "",
      contract,
      difference: this.#difference(recovery, origin),
      recovery: `${recovery.label} at line ${lineOf(recovery.node)}`,
      owner:
        owner.kind === "elsewhere"
          ? ` \`${contract}\` is declared in ${owner.location}.`
          : "",
    };
  }

  #display(type: ts.Type): string {
    const text = this.#checker.typeToString(type);
    return text.length > TYPE_TEXT_LENGTH
      ? `${text.slice(0, TYPE_TEXT_LENGTH - 1)}…`
      : text;
  }

  #difference(recovery: Recovery, origin: Origin): string {
    const { discriminant } = recovery.test;
    if (discriminant && origin.path.length > 0) {
      const keyed = pathText([
        ...origin.path,
        { kind: "member", key: discriminant.key },
      ]);
      return `\`${keyed}\` as \`${this.#display(discriminant.literal)}\``;
    }
    if (origin.path.length > 0) {
      return `\`${pathText(origin.path)}\` as ${recovery.test.restores}`;
    }
    const target = recovery.test.target;
    return target
      ? this.#rootLoss(
          this.#checker.getTypeAtLocation(recovery.operand),
          target
        )
      : recovery.test.restores;
  }

  #rootLoss(slotType: ts.Type, target: ts.Type): string {
    const checker = this.#checker;
    const slotValues = checker.getIndexTypeOfType(
      slotType,
      ts.IndexKind.String
    );
    const targetValues = checker.getIndexTypeOfType(
      target,
      ts.IndexKind.String
    );
    if (
      slotValues &&
      isTopType(slotValues) &&
      targetValues &&
      !isTopType(targetValues)
    ) {
      return `the value type \`${this.#display(targetValues)}\``;
    }
    const core = target.getNonNullableType();
    if (
      core.isUnion() &&
      core.types.every((member) => this.#objectLike(member))
    ) {
      return `which \`${this.#display(target)}\` member it is`;
    }
    if (isTopType(slotType) || !this.#objectLike(core)) {
      return `\`${this.#display(target)}\``;
    }
    const slotCore = slotType.getNonNullableType();
    const missing: string[] = [];
    const required: string[] = [];
    for (const property of checker.getPropertiesOfType(core)) {
      const own = checker.getPropertyOfType(slotCore, property.name);
      if (!own) {
        missing.push(property.name);
      } else if (
        (own.flags & ts.SymbolFlags.Optional) !== 0 &&
        (property.flags & ts.SymbolFlags.Optional) === 0
      ) {
        required.push(property.name);
      }
    }
    if (missing.length > 0) {
      return `the ${missing.length === 1 ? "key" : "keys"} ${quotedList(missing)}`;
    }
    if (required.length > 0) {
      return `the required ${required.length === 1 ? "key" : "keys"} ${quotedList(required)}`;
    }
    return `\`${this.#display(target)}\``;
  }

  #objectLike(type: ts.Type): boolean {
    return (
      (type.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection)) !== 0 &&
      type.getCallSignatures().length === 0 &&
      !this.#checker.isArrayLikeType(type)
    );
  }
}
