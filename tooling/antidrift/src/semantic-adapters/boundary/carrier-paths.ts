import ts from "typescript";

import { isWrapperExpression, unwrapExpression } from "./boundary-syntax.ts";
import { broad } from "./boundary-types.ts";
import type { DeclarationFacts } from "./declaration-facts.ts";
import { rowMatchesOwner } from "./declaration-facts.ts";
import { carrierCases } from "./decision-cases.ts";

export type CarrierPath = {
  readonly parameter: ts.ParameterDeclaration;
  readonly path: readonly string[];
  readonly asserted: boolean;
  readonly deserialized?: boolean;
};

export type CarrierSuccess = {
  readonly discriminant: string;
  readonly success: unknown;
};

export function requiredCarrier(carrier: CarrierPath | null): CarrierPath {
  if (!carrier) {
    throw new TypeError(
      "Boundary model: a decoder without a subject parameter matched a check that has no parameter carrier"
    );
  }
  return carrier;
}

function literalConstant(type: ts.Type) {
  if (type.flags & ts.TypeFlags.BooleanLiteral) {
    return type.intrinsicName === "true";
  }
  return type.isLiteral() ? type.value : undefined;
}

export class CarrierPaths {
  readonly #checker: ts.TypeChecker;
  readonly #facts: DeclarationFacts;

  constructor(checker: ts.TypeChecker, facts: DeclarationFacts) {
    this.#checker = checker;
    this.#facts = facts;
  }

  passesAssertion(expression: ts.Expression | undefined): boolean {
    let current = expression;
    while (current && isWrapperExpression(current) && current.expression) {
      if (
        (ts.isAsExpression(current) || ts.isTypeAssertionExpression(current)) &&
        !this.#inspectionAssertion(current)
      ) {
        return true;
      }
      current = current.expression;
    }
    return false;
  }

  deserializedArgument(call: ts.CallExpression): ts.Expression | undefined {
    const declaration = this.#checker.getResolvedSignature(call)?.declaration;
    const row = declaration && this.#facts.platformSource(declaration);
    return row?.requiresProvenance ? call.arguments[row.argument] : undefined;
  }

  carrierPath(
    expression: ts.Expression | undefined,
    visited = new Set<ts.Node>()
  ): CarrierPath | null {
    const unwrapped = unwrapExpression(expression);
    if (!unwrapped || visited.has(unwrapped)) {
      return null;
    }
    visited.add(unwrapped);
    const asserted = this.passesAssertion(expression);
    if (ts.isPropertyAccessExpression(unwrapped)) {
      const carrier = this.carrierPath(unwrapped.expression, visited);
      return (
        carrier && {
          ...carrier,
          path: [...carrier.path, unwrapped.name.text],
          asserted: carrier.asserted || asserted,
        }
      );
    }
    if (ts.isCallExpression(unwrapped)) {
      const opened = this.deserializedArgument(unwrapped);
      const carrier = opened ? this.carrierPath(opened, visited) : null;
      return (
        carrier && {
          ...carrier,
          path: [],
          deserialized: true,
          asserted: carrier.asserted || asserted,
        }
      );
    }
    return ts.isIdentifier(unwrapped)
      ? this.#identifierCarrier(unwrapped, asserted, visited)
      : null;
  }

  subjectReference(expression: ts.Expression, subject: ts.Node | undefined) {
    const carrier = this.carrierPath(expression);
    return Boolean(
      carrier && carrier.parameter === subject && !carrier.asserted
    );
  }

  carrierContract(declaration: ts.Node, output: ts.Type) {
    if (!output.isUnion()) {
      return null;
    }
    const ownerName = this.#facts.packageAt(
      declaration.getSourceFile().fileName
    )?.name;
    for (const row of carrierCases) {
      if (!rowMatchesOwner(row, ownerName)) {
        continue;
      }
      const success = output.types.find(
        (variant) =>
          this.#discriminantMatches(variant, row.discriminant, row.success) &&
          this.#checker.getPropertyOfType(variant, row.payload)
      );
      if (success) {
        return { ...row, successVariant: success };
      }
    }
    return null;
  }

  narrowedToSuccess(type: ts.Type, carrier: CarrierSuccess): boolean {
    const nonNull = type.getNonNullableType();
    const variants = nonNull.isUnion() ? nonNull.types : [nonNull];
    const { discriminant, success } = carrier;
    return variants.every((variant) =>
      this.#discriminantMatches(variant, discriminant, success)
    );
  }

  #discriminantMatches(
    variant: ts.Type,
    discriminant: string,
    success: unknown
  ): boolean {
    const member = this.#checker.getPropertyOfType(variant, discriminant);
    const memberType = member && this.#checker.getTypeOfSymbol(member);
    return Boolean(memberType && literalConstant(memberType) === success);
  }

  #identifierCarrier(
    identifier: ts.Identifier,
    asserted: boolean,
    visited: Set<ts.Node>
  ): CarrierPath | null {
    for (const declaration of this.#checker.getSymbolAtLocation(identifier)
      ?.declarations ?? []) {
      if (ts.isParameter(declaration)) {
        return { parameter: declaration, path: [], asserted };
      }
      if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
        const carrier = this.carrierPath(declaration.initializer, visited);
        return (
          carrier && { ...carrier, asserted: carrier.asserted || asserted }
        );
      }
    }
    return null;
  }

  #inspectionShape(type: ts.Type): boolean {
    if (
      !(type.flags & ts.TypeFlags.Object) ||
      type.getCallSignatures().length ||
      type.getConstructSignatures().length
    ) {
      return false;
    }
    const members = [
      ...this.#checker
        .getPropertiesOfType(type)
        .map((property) => this.#checker.getTypeOfSymbol(property)),
      ...this.#checker.getIndexInfosOfType(type).map((index) => index.type),
    ];
    return (
      members.length > 0 &&
      members.every((member) => (member.flags & ts.TypeFlags.Unknown) !== 0)
    );
  }

  #inspectionAssertion(assertion: ts.AsExpression | ts.TypeAssertion): boolean {
    return (
      this.#inspectionShape(
        this.#checker.getTypeFromTypeNode(assertion.type)
      ) && !broad(this.#checker.getTypeAtLocation(assertion.expression))
    );
  }
}
