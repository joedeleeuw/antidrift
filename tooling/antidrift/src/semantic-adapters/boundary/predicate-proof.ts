import ts from "typescript";

import type { CarrierPaths } from "./carrier-paths.ts";
import { requiredCarrier } from "./carrier-paths.ts";
import { primitiveGuardCases } from "./decision-cases.ts";
import type { DecodeEvidence, DecoderSubject } from "./decoder-forms.ts";

export type PredicateContext = {
  readonly checker: ts.TypeChecker;
  readonly carriers: CarrierPaths;
  readonly decode: (call: ts.Node) => DecodeEvidence | null;
};

type PredicateCheck =
  | { readonly kind: "typeof"; readonly guard: string }
  | { readonly kind: "literal"; readonly contract: ts.Type };

function isLiteralOperand(expression: ts.Expression): boolean {
  return (
    ts.isStringLiteral(expression) ||
    ts.isNumericLiteral(expression) ||
    expression.kind === ts.SyntaxKind.TrueKeyword ||
    expression.kind === ts.SyntaxKind.FalseKeyword
  );
}

export class PredicateProof {
  readonly #checker: ts.TypeChecker;
  readonly #carriers: CarrierPaths;
  readonly #decode: PredicateContext["decode"];

  constructor(context: PredicateContext) {
    this.#checker = context.checker;
    this.#carriers = context.carriers;
    this.#decode = context.decode;
  }

  #checks(
    expression: ts.Expression,
    parameter: DecoderSubject,
    checks = new Map<string, PredicateCheck>()
  ): Map<string, PredicateCheck> {
    if (ts.isParenthesizedExpression(expression)) {
      return this.#checks(expression.expression, parameter, checks);
    }
    if (!ts.isBinaryExpression(expression)) {
      return checks;
    }
    const operator = expression.operatorToken.kind;
    if (operator === ts.SyntaxKind.AmpersandAmpersandToken) {
      this.#checks(expression.left, parameter, checks);
      this.#checks(expression.right, parameter, checks);
      return checks;
    }
    if (operator !== ts.SyntaxKind.EqualsEqualsEqualsToken) {
      return checks;
    }
    const { left, right } = expression;
    if (ts.isTypeOfExpression(left) && ts.isStringLiteral(right)) {
      const carrier = this.#carriers.carrierPath(left.expression);
      if (carrier?.parameter === parameter) {
        checks.set(requiredCarrier(carrier).path.join("."), {
          kind: "typeof",
          guard: right.text,
        });
      }
      return checks;
    }
    const carrier = this.#carriers.carrierPath(left);
    if (carrier?.parameter === parameter && isLiteralOperand(right)) {
      const contract = this.#checker.getTypeAtLocation(right);
      checks.set(requiredCarrier(carrier).path.join("."), {
        kind: "literal",
        contract,
      });
    }
    return checks;
  }

  returnProves(
    expression: ts.Expression,
    parameter: DecoderSubject,
    output: ts.Type | undefined
  ): boolean {
    if (!output) {
      return false;
    }
    if (ts.isCallExpression(expression)) {
      const evidence = this.#decode(expression);
      return Boolean(
        evidence?.kind === "predicate" &&
        this.#carriers.subjectReference(evidence.input, parameter) &&
        evidence.output &&
        this.#checker.isTypeAssignableTo(evidence.output, output)
      );
    }
    const checks = this.#checks(expression, parameter);
    const properties = this.#checker.getPropertiesOfType(output);
    const subjects: (readonly [string, ts.Type])[] = properties.length
      ? properties.map((property) => [
          property.name,
          this.#checker.getTypeOfSymbol(property),
        ])
      : [["", output]];
    return subjects.every(([name, contract]) => {
      const check = checks.get(name);
      if (!check) {
        return false;
      }
      if (check.kind === "literal") {
        return this.#checker.isTypeAssignableTo(check.contract, contract);
      }
      return primitiveGuardCases.some(
        (guard) =>
          check.guard === guard.typeof &&
          (contract.flags & ts.TypeFlags[guard.flag]) !== 0
      );
    });
  }

  assertionBody(
    body: ts.ConciseBody,
    parameter: DecoderSubject,
    output: ts.Type | undefined
  ): boolean {
    if (!ts.isBlock(body)) {
      return false;
    }
    const guard = body.statements.at(-1);
    if (!guard || !ts.isIfStatement(guard) || guard.elseStatement) {
      return false;
    }
    const condition = guard.expression;
    const failure = ts.isBlock(guard.thenStatement)
      ? guard.thenStatement.statements.at(-1)
      : guard.thenStatement;
    return (
      ts.isPrefixUnaryExpression(condition) &&
      condition.operator === ts.SyntaxKind.ExclamationToken &&
      failure !== undefined &&
      ts.isThrowStatement(failure) &&
      this.returnProves(condition.operand, parameter, output)
    );
  }
}
