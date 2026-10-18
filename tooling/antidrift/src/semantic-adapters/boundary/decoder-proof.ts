import ts from "typescript";

import type { BoundaryObserver } from "./boundary-observations.ts";
import { boundaryObservations } from "./boundary-observations.ts";
import {
  callbackReturns,
  enclosingFunction,
  isWrapperExpression,
  unwrapExpression,
} from "./boundary-syntax.ts";
import { broad, typed } from "./boundary-types.ts";
import type { CarrierPaths } from "./carrier-paths.ts";
import { requiredCarrier } from "./carrier-paths.ts";
import type { DeclarationFacts } from "./declaration-facts.ts";
import type {
  DecoderSubject,
  SignatureDeclaration,
  SignatureEvidence,
} from "./decoder-forms.ts";
import type { PredicateContext } from "./predicate-proof.ts";
import { PredicateProof } from "./predicate-proof.ts";

type ProofContext = PredicateContext & {
  readonly facts: DeclarationFacts;
  readonly observer: BoundaryObserver;
};

const { decoderBranches } = boundaryObservations;

function terminates(statement: ts.Statement | undefined): boolean {
  if (!statement) {
    return false;
  }
  if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) {
    return true;
  }
  if (ts.isBlock(statement)) {
    return statement.statements.some(terminates);
  }
  return (
    ts.isIfStatement(statement) &&
    terminates(statement.thenStatement) &&
    terminates(statement.elseStatement)
  );
}

function failureLiteral(expression: ts.Expression): boolean {
  const unwrapped = unwrapExpression(expression);
  return (
    unwrapped.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(unwrapped) && unwrapped.text === "undefined") ||
    ts.isReturnStatement(unwrapped)
  );
}

function evidenceSubject(
  declaration: SignatureDeclaration,
  evidence: SignatureEvidence
) {
  return evidence.parameter === undefined
    ? undefined
    : declaration.parameters[evidence.parameter];
}

function isAssertionForm(evidence: SignatureEvidence): boolean {
  return evidence.kind === "predicate" && evidence.form === "assertion";
}

export class DecoderImplementationProof {
  readonly #checker: ts.TypeChecker;
  readonly #carriers: CarrierPaths;
  readonly #facts: DeclarationFacts;
  readonly #observer: BoundaryObserver;
  readonly #decode: ProofContext["decode"];
  readonly #predicates: PredicateProof;
  readonly #proofs = new WeakMap<SignatureDeclaration, boolean>();

  constructor(context: ProofContext) {
    this.#checker = context.checker;
    this.#carriers = context.carriers;
    this.#facts = context.facts;
    this.#observer = context.observer;
    this.#decode = context.decode;
    this.#predicates = new PredicateProof(context);
  }

  prove(declaration: SignatureDeclaration, evidence: SignatureEvidence) {
    const cached = this.#proofs.get(declaration);
    if (cached !== undefined) {
      return cached;
    }
    this.#proofs.set(declaration, false);
    if (!("body" in declaration) || !declaration.body) {
      if (this.#observer.enabled) {
        this.#observer.decoderProof({
          declaration,
          evidence,
          proved: false,
          branch: decoderBranches.derivationRefused,
        });
      }
      return false;
    }
    const returns = callbackReturns(declaration);
    const proven = this.#bodyProves(
      declaration,
      declaration.body,
      evidence,
      returns
    );
    this.#proofs.set(declaration, proven);
    if (this.#observer.enabled) {
      this.#observer.decoderProof({
        declaration,
        evidence,
        proved: proven,
        branch: this.#decoderBranch(declaration, evidence, returns, proven),
      });
    }
    return proven;
  }

  unprovedNarrowing(expression: ts.Expression | undefined): boolean {
    let subject = unwrapExpression(expression);
    while (
      subject &&
      (ts.isPropertyAccessExpression(subject) ||
        ts.isElementAccessExpression(subject))
    ) {
      subject = unwrapExpression(subject.expression);
    }
    if (!subject || !ts.isIdentifier(subject)) {
      return false;
    }
    const owner = enclosingFunction(subject);
    const ownerBody = owner && "body" in owner ? owner.body : undefined;
    const symbol = this.#checker.getSymbolAtLocation(subject);
    if (!ownerBody || !symbol) {
      return false;
    }
    const subjectStart = subject.pos;
    const visit = (node: ts.Node): boolean => {
      if (ts.isFunctionLike(node) || node.pos >= subjectStart) {
        return false;
      }
      if (ts.isCallExpression(node) && this.#narrowsSymbol(node, symbol)) {
        return true;
      }
      return ts.forEachChild(node, visit) ?? false;
    };
    return visit(ownerBody);
  }

  #narrowsSymbol(call: ts.CallExpression, symbol: ts.Symbol): boolean {
    const signature = this.#checker.getResolvedSignature(call);
    const predicate =
      signature && this.#checker.getTypePredicateOfSignature(signature);
    const narrowed =
      predicate?.parameterIndex === undefined
        ? undefined
        : call.arguments[predicate.parameterIndex];
    return (
      narrowed !== undefined &&
      this.#checker.getSymbolAtLocation(narrowed) === symbol &&
      !this.#decode(call)
    );
  }

  #bodyProves(
    declaration: ts.FunctionLikeDeclaration,
    body: ts.ConciseBody,
    evidence: SignatureEvidence,
    returns: readonly ts.Expression[]
  ): boolean {
    const parameter = evidenceSubject(declaration, evidence);
    if (isAssertionForm(evidence) && !returns.length) {
      return this.#predicates.assertionBody(body, parameter, evidence.output);
    }
    const provedReturn = (expression: ts.Expression): boolean =>
      evidence.kind === "predicate"
        ? this.#predicates.returnProves(expression, parameter, evidence.output)
        : this.#validatedExpression(expression, parameter);
    return (
      (!ts.isBlock(body) || terminates(body)) &&
      returns.some(provedReturn) &&
      returns.every(
        (expression) =>
          provedReturn(expression) ||
          (evidence.kind !== "predicate" && failureLiteral(expression))
      )
    );
  }

  #decoderBranch(
    declaration: ts.FunctionLikeDeclaration,
    evidence: SignatureEvidence,
    returns: readonly ts.Expression[],
    proven: boolean
  ): string {
    if (isAssertionForm(evidence) && !returns.length) {
      return decoderBranches.assertionBody;
    }
    if (evidence.kind === "predicate") {
      return decoderBranches.predicateReturn;
    }
    if (!declaration.body || !returns.length) {
      return decoderBranches.derivationRefused;
    }
    if (proven) {
      return returns.some(failureLiteral)
        ? decoderBranches.failureLiteral
        : decoderBranches.validatedReturn;
    }
    const parameter = evidenceSubject(declaration, evidence);
    if (
      returns.some((expression) =>
        this.#blockedByUnprovedNarrowing(expression, parameter)
      )
    ) {
      return decoderBranches.unprovedNarrowing;
    }
    return returns.every(failureLiteral)
      ? decoderBranches.failureLiteral
      : decoderBranches.derivationRefused;
  }

  #assignedExpressions(declaration: ts.VariableDeclaration): ts.Expression[] {
    const symbol = this.#checker.getSymbolAtLocation(declaration.name);
    const scope = enclosingFunction(declaration) ?? declaration.getSourceFile();
    const expressions: ts.Expression[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        this.#checker.getSymbolAtLocation(node.left) === symbol
      ) {
        expressions.push(node.right);
      }
      ts.forEachChild(node, visit);
    };
    visit(scope);
    return expressions;
  }

  #derivesFromSubject(
    expression: ts.Expression,
    parameter: DecoderSubject,
    visited = new Set<ts.Node>()
  ): boolean {
    const unwrapped = unwrapExpression(expression);
    if (visited.has(unwrapped) || this.#carriers.passesAssertion(expression)) {
      return false;
    }
    visited.add(unwrapped);
    if (
      ts.isPropertyAccessExpression(unwrapped) ||
      ts.isElementAccessExpression(unwrapped)
    ) {
      return this.#derivesFromSubject(unwrapped.expression, parameter, visited);
    }
    if (ts.isCallExpression(unwrapped)) {
      const opened = this.#carriers.deserializedArgument(unwrapped);
      if (opened) {
        return this.#derivesFromSubject(opened, parameter, visited);
      }
      const evidence = this.#decode(unwrapped);
      if (evidence) {
        return this.#derivesFromSubject(evidence.input, parameter, visited);
      }
      const signature = this.#checker.getResolvedSignature(unwrapped);
      const declaration = signature?.declaration;
      const returned =
        signature && this.#checker.getReturnTypeOfSignature(signature);
      return Boolean(
        declaration &&
        returned &&
        this.#facts.origin(declaration, unwrapped) === null &&
        broad(this.#checker.getAwaitedType(returned) ?? returned) &&
        unwrapped.arguments.some((argument) =>
          this.#derivesFromSubject(argument, parameter, visited)
        )
      );
    }
    if (!ts.isIdentifier(unwrapped)) {
      return false;
    }
    return (
      this.#checker.getSymbolAtLocation(unwrapped)?.declarations ?? []
    ).some((declaration) => {
      if (declaration === parameter) {
        return true;
      }
      if (!ts.isVariableDeclaration(declaration)) {
        return false;
      }
      const sources = declaration.initializer
        ? [declaration.initializer]
        : this.#assignedExpressions(declaration);
      return (
        sources.length > 0 &&
        sources.every((source) =>
          this.#derivesFromSubject(source, parameter, new Set(visited))
        )
      );
    });
  }

  #annotatedInitializer(expression: ts.Expression) {
    if (!ts.isIdentifier(expression)) {
      return undefined;
    }
    for (const declaration of this.#checker.getSymbolAtLocation(expression)
      ?.declarations ?? []) {
      if (
        ts.isVariableDeclaration(declaration) &&
        declaration.type &&
        declaration.initializer
      ) {
        return declaration.initializer;
      }
    }
    return undefined;
  }

  #validatedExpression(
    expression: ts.Expression | undefined,
    parameter: DecoderSubject,
    visited = new Set<ts.Node>()
  ): boolean {
    if (!expression || visited.has(expression)) {
      return false;
    }
    visited.add(expression);
    if (
      ts.isAsExpression(expression) ||
      ts.isTypeAssertionExpression(expression)
    ) {
      return false;
    }
    if (isWrapperExpression(expression)) {
      return this.#validatedExpression(
        expression.expression,
        parameter,
        visited
      );
    }
    if (ts.isCallExpression(expression)) {
      const evidence = this.#decode(expression);
      return Boolean(
        evidence && this.#carriers.subjectReference(evidence.input, parameter)
      );
    }
    const annotated = this.#annotatedInitializer(expression);
    if (annotated) {
      return this.#validatedExpression(annotated, parameter, visited);
    }
    return this.#validatedValue(expression, parameter, visited);
  }

  #validatedValue(
    expression: ts.Expression,
    parameter: DecoderSubject,
    visited: Set<ts.Node>
  ): boolean {
    const carrier = this.#carriers.carrierPath(expression);
    if (carrier?.parameter === parameter) {
      return (
        !requiredCarrier(carrier).asserted &&
        typed(this.#checker.getTypeAtLocation(expression))
      );
    }
    if (
      this.#derivesFromSubject(expression, parameter) &&
      typed(this.#checker.getTypeAtLocation(expression)) &&
      !this.unprovedNarrowing(expression)
    ) {
      return true;
    }
    if (ts.isObjectLiteralExpression(expression)) {
      return this.#validatedObject(expression, parameter, visited);
    }
    if (ts.isConditionalExpression(expression)) {
      const branches = [expression.whenTrue, expression.whenFalse];
      return (
        branches.some((branch) =>
          this.#validatedExpression(branch, parameter, new Set(visited))
        ) &&
        branches.every(
          (branch) =>
            this.#validatedExpression(branch, parameter, new Set(visited)) ||
            failureLiteral(branch)
        )
      );
    }
    if (!ts.isIdentifier(expression)) {
      return false;
    }
    return (
      this.#checker.getSymbolAtLocation(expression)?.declarations ?? []
    ).some(
      (declaration) =>
        ts.isVariableDeclaration(declaration) &&
        this.#validatedExpression(declaration.initializer, parameter, visited)
    );
  }

  #validatedObject(
    expression: ts.ObjectLiteralExpression,
    parameter: DecoderSubject,
    visited: Set<ts.Node>
  ): boolean {
    const fields = expression.properties.filter(ts.isPropertyAssignment);
    return (
      fields.length === expression.properties.length &&
      fields.some((field) =>
        this.#validatedExpression(
          field.initializer,
          parameter,
          new Set(visited)
        )
      ) &&
      fields.every(
        (field) =>
          this.#validatedExpression(
            field.initializer,
            parameter,
            new Set(visited)
          ) || ts.isLiteralExpression(field.initializer)
      )
    );
  }

  #blockedByUnprovedNarrowing(
    expression: ts.Expression | undefined,
    parameter: DecoderSubject,
    visited = new Set<ts.Node>()
  ): boolean {
    const unwrapped = unwrapExpression(expression);
    if (!unwrapped || visited.has(unwrapped)) {
      return false;
    }
    visited.add(unwrapped);
    if (
      this.#derivesFromSubject(unwrapped, parameter) &&
      typed(this.#checker.getTypeAtLocation(unwrapped)) &&
      this.unprovedNarrowing(unwrapped)
    ) {
      return true;
    }
    if (!ts.isIdentifier(unwrapped)) {
      return false;
    }
    return (
      this.#checker.getSymbolAtLocation(unwrapped)?.declarations ?? []
    ).some(
      (declaration) =>
        ts.isVariableDeclaration(declaration) &&
        this.#blockedByUnprovedNarrowing(
          declaration.initializer,
          parameter,
          visited
        )
    );
  }
}
