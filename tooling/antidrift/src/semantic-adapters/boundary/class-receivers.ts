import ts from "typescript";

import { aliasTarget } from "../provenance/symbol-provenance.ts";
import type { ContractProjections } from "./boundary-contracts.ts";
import { enclosingFunction } from "./boundary-syntax.ts";
import type { DeclarationFacts } from "./declaration-facts.ts";
import type { rootAlgebra } from "./root-algebra.ts";
import type { Root } from "./root-domain.ts";
import { unknownProvenance } from "./root-domain.ts";

type ReceiverContext = {
  readonly checker: ts.TypeChecker;
  readonly origin: DeclarationFacts["origin"];
  readonly propertyKeys: ContractProjections["propertyKeys"];
  readonly trace: (expression: ts.Node | undefined) => readonly Root[];
  readonly summary: (declaration: ts.Node) => readonly Root[];
  readonly parameterRoots: (
    parameter: ts.ParameterDeclaration
  ) => readonly Root[];
  readonly prefixed: ReturnType<typeof rootAlgebra>["prefixed"];
};

function bindsThisToClass(ancestor: ts.SignatureDeclaration): boolean {
  if (ts.isArrowFunction(ancestor)) {
    return true;
  }
  if (ts.isMethodDeclaration(ancestor) || ts.isAccessor(ancestor)) {
    return !ts.isObjectLiteralExpression(ancestor.parent);
  }
  return ts.isConstructorDeclaration(ancestor);
}

function enclosingClass(node: ts.Node): ts.ClassLikeDeclaration | null {
  const owner = ts.findAncestor(node.parent, (ancestor) => {
    if (ts.isClassLike(ancestor)) {
      return true;
    }
    return ts.isFunctionLike(ancestor) && !bindsThisToClass(ancestor)
      ? "quit"
      : false;
  });
  return owner && ts.isClassLike(owner) ? owner : null;
}

function thisFieldWrite(node: ts.Node) {
  if (
    !ts.isBinaryExpression(node) ||
    node.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    !ts.isPropertyAccessExpression(node.left) ||
    node.left.expression.kind !== ts.SyntaxKind.ThisKeyword
  ) {
    return null;
  }
  return { key: node.left.name.text, value: node.right };
}

function thisReceiverParameter(expression: ts.Node) {
  let ancestor = enclosingFunction(expression);
  while (ancestor && ts.isArrowFunction(ancestor)) {
    ancestor = enclosingFunction(ancestor);
  }
  return ancestor?.parameters.find(
    (parameter) =>
      ts.isIdentifier(parameter.name) && parameter.name.text === "this"
  );
}

function isParameterProperty(
  parameter: ts.ParameterDeclaration
): parameter is ts.ParameterDeclaration & { readonly name: ts.Identifier } {
  return (
    ts.isIdentifier(parameter.name) &&
    (ts.getCombinedModifierFlags(parameter) &
      ts.ModifierFlags.ParameterPropertyModifier) !==
      0
  );
}

class ClassReceivers {
  readonly #context: ReceiverContext;

  constructor(context: ReceiverContext) {
    this.#context = context;
  }

  classFieldRoots(classDeclaration: ts.ClassLikeDeclaration): Root[] {
    const { parameterRoots, prefixed } = this.#context;
    const roots: Root[] = [];
    for (const member of classDeclaration.members) {
      if (ts.isPropertyDeclaration(member) && member.initializer) {
        roots.push(
          ...this.#fieldWrite(
            this.#context.propertyKeys(member),
            member.initializer
          )
        );
      }
      if (ts.isConstructorDeclaration(member)) {
        for (const parameter of member.parameters.filter(isParameterProperty)) {
          roots.push(
            ...parameterRoots(parameter).map((root) =>
              prefixed(root, parameter.name.text, parameter)
            )
          );
        }
      }
    }
    const visit = (node: ts.Node): void => {
      const write = thisFieldWrite(node);
      if (write) {
        roots.push(...this.#fieldWrite([write.key], write.value));
      }
      ts.forEachChild(node, visit);
    };
    for (const member of classDeclaration.members) {
      visit(member);
    }
    return roots;
  }

  thisRoots(expression: ts.Node): readonly Root[] {
    const owner = enclosingClass(expression);
    if (owner) {
      return this.#context.summary(owner);
    }
    const receiver = thisReceiverParameter(expression);
    if (receiver) {
      return this.#context.parameterRoots(receiver);
    }
    return unknownProvenance(expression, "this receiver outside a class");
  }

  superRoots(expression: ts.Node): readonly Root[] {
    const { checker } = this.#context;
    const owner = enclosingClass(expression);
    const heritage = owner?.heritageClauses?.find(
      (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword
    );
    const base = heritage?.types[0]?.expression;
    const target =
      base && aliasTarget(checker, checker.getSymbolAtLocation(base));
    const declaration = target?.declarations?.find(ts.isClassLike);
    if (
      !declaration ||
      this.#context.origin(declaration, expression) !== null
    ) {
      return unknownProvenance(expression, "super of an unresolved class");
    }
    return this.#context.summary(declaration);
  }

  #fieldWrite(
    keys: ReadonlySet<string> | readonly string[] | null,
    expression: ts.Expression
  ): Root[] {
    const { trace, prefixed } = this.#context;
    return [...(keys ?? [])].flatMap((key) =>
      trace(expression).map((root) => prefixed(root, key, expression))
    );
  }
}

export function classReceivers(context: ReceiverContext) {
  const receivers = new ClassReceivers(context);
  return {
    classFieldRoots: receivers.classFieldRoots.bind(receivers),
    superRoots: receivers.superRoots.bind(receivers),
    thisRoots: receivers.thisRoots.bind(receivers),
  };
}
