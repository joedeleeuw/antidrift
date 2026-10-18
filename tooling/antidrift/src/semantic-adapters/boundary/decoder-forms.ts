import ts from "typescript";

import { broad, typed } from "./boundary-types.ts";
import type { CarrierPaths } from "./carrier-paths.ts";
import { decoderCases, excluded } from "./decision-cases.ts";

export type SignatureDeclaration = NonNullable<ts.Signature["declaration"]>;

export type SignatureEvidence = NonNullable<
  ReturnType<DecoderForms["signatureForm"]>
>;

export type DecoderSubject =
  | SignatureDeclaration["parameters"][number]
  | undefined;

export type DecodeEvidence = SignatureEvidence & {
  readonly call: ts.CallExpression;
  readonly input: ts.Expression;
};

function predicateForm(predicate: ts.TypePredicate | undefined) {
  if (!predicate) {
    return undefined;
  }
  return predicate.kind === ts.TypePredicateKind.AssertsIdentifier ||
    predicate.kind === ts.TypePredicateKind.AssertsThis
    ? "asserts"
    : "is";
}

export class DecoderForms {
  readonly #checker: ts.TypeChecker;
  readonly #carriers: CarrierPaths;

  constructor(checker: ts.TypeChecker, carriers: CarrierPaths) {
    this.#checker = checker;
    this.#carriers = carriers;
  }

  signatureForm(signature: ts.Signature | undefined) {
    if (!signature) {
      return null;
    }
    const predicate = this.#checker.getTypePredicateOfSignature(signature);
    const output = this.#checker.getAwaitedType(
      this.#checker.getReturnTypeOfSignature(signature)
    );
    const { declaration } = signature;
    const declared =
      declaration && this.#checker.getSignatureFromDeclaration(declaration);
    if (!declaration || !declared) {
      return null;
    }
    const broadParameter = declared.parameters.findIndex((symbol) =>
      broad(this.#checker.getTypeOfSymbol(symbol))
    );
    const deserializedParameter =
      broadParameter >= 0
        ? -1
        : this.#deserializedParameterIndex(declaration, declared);
    const parameter = Math.max(broadParameter, deserializedParameter);
    if (excluded({ unresolvedReturn: !output }) || !output) {
      return null;
    }
    const carrier = this.#carriers.carrierContract(declaration, output);
    const form = predicateForm(predicate);
    for (const row of decoderCases) {
      if (predicate && "predicate" in row && row.predicate === form) {
        return {
          kind: row.output,
          form: row.kind,
          parameter: predicate.parameterIndex,
          output: predicate.type,
        };
      }
      if ("input" in row && parameter >= 0 && typed(output)) {
        if (row.output === "carrier" && carrier) {
          return { kind: row.kind, parameter, output, carrier };
        }
        if (row.output === "typed" && !carrier) {
          return {
            kind: row.kind,
            parameter,
            output,
            deserializes: parameter === deserializedParameter,
          };
        }
      }
    }
    return null;
  }

  #deserializedParameterIndex(
    declaration: SignatureDeclaration,
    declared: ts.Signature
  ): number {
    return declared.parameters.findIndex((symbol) => {
      const parameter = symbol.valueDeclaration;
      return (
        (this.#checker.getTypeOfSymbol(symbol).flags & ts.TypeFlags.String) !==
          0 &&
        parameter !== undefined &&
        ts.isParameter(parameter) &&
        this.#deserializesParameter(declaration, parameter)
      );
    });
  }

  #deserializesParameter(
    declaration: SignatureDeclaration,
    parameter: ts.ParameterDeclaration
  ): boolean {
    const body = "body" in declaration ? declaration.body : undefined;
    if (!body) {
      return false;
    }
    const visit = (node: ts.Node): boolean => {
      if (ts.isCallExpression(node)) {
        const opened = this.#carriers.deserializedArgument(node);
        const carrier = opened ? this.#carriers.carrierPath(opened) : null;
        if (carrier?.parameter === parameter && !carrier.deserialized) {
          return true;
        }
      }
      return ts.forEachChild(node, visit) ?? false;
    };
    return visit(body);
  }
}
