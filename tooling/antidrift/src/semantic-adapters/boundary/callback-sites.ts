import ts from "typescript";

import { aliasTarget } from "../provenance/symbol-provenance.ts";
import type { BoundaryDeclarations } from "./boundary-declarations.ts";
import { unwrapExpression } from "./boundary-syntax.ts";

export type HostCall = ts.CallExpression | ts.NewExpression;

function isTransparentWrapper(node: ts.Node): boolean {
  return (
    ts.isParenthesizedExpression(node) ||
    ts.isPropertyAssignment(node) ||
    ts.isObjectLiteralExpression(node) ||
    ts.isArrayLiteralExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node)
  );
}

function isInlineCallback(
  node: ts.Node
): node is ts.ArrowFunction | ts.FunctionExpression {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

export function callbackNodes(argument: ts.Node) {
  if (isInlineCallback(argument)) {
    return [argument];
  }
  if (!ts.isObjectLiteralExpression(argument)) {
    return [];
  }
  return argument.properties.flatMap(
    (
      property
    ): (ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration)[] => {
      if (
        ts.isPropertyAssignment(property) &&
        isInlineCallback(property.initializer)
      ) {
        return [property.initializer];
      }
      return ts.isMethodDeclaration(property) ? [property] : [];
    }
  );
}

export function callbackUpstreamCandidates(callback: ts.Node, call: HostCall) {
  const candidates: ts.Expression[] = [...(call.arguments ?? [])].filter(
    (argument) => unwrapExpression(argument) !== callback
  );
  if (ts.isPropertyAccessExpression(call.expression)) {
    candidates.push(call.expression.expression);
  }
  if (ts.isCallExpression(call.parent)) {
    if (ts.isPropertyAccessExpression(call.parent.expression)) {
      candidates.push(call.parent.expression.expression);
    }
    const position = call.parent.arguments.indexOf(call);
    candidates.push(...call.parent.arguments.slice(0, position));
  }
  return candidates;
}

export function hostCallOf(callback: ts.Node): HostCall | null {
  let child = callback;
  const host = ts.findAncestor(callback.parent, (node) => {
    if (
      (ts.isCallExpression(node) || ts.isNewExpression(node)) &&
      node.arguments?.some((argument) => argument === child)
    ) {
      return true;
    }
    if (!isTransparentWrapper(node)) {
      return "quit";
    }
    child = node;
    return false;
  });
  return host && (ts.isCallExpression(host) || ts.isNewExpression(host))
    ? host
    : null;
}

export class CallbackDeclarations {
  readonly #checker: ts.TypeChecker;
  readonly #origin: BoundaryDeclarations["origin"];

  constructor(checker: ts.TypeChecker, origin: BoundaryDeclarations["origin"]) {
    this.#checker = checker;
    this.#origin = origin;
  }

  callbackDeclaration(argument: ts.Expression) {
    const unwrapped = unwrapExpression(argument);
    if (
      !ts.isIdentifier(unwrapped) &&
      !ts.isPropertyAccessExpression(unwrapped)
    ) {
      return null;
    }
    const target = aliasTarget(
      this.#checker,
      this.#checker.getSymbolAtLocation(unwrapped)
    );
    for (const declaration of target?.declarations ?? []) {
      const candidate = ts.isVariableDeclaration(declaration)
        ? declaration.initializer
        : declaration;
      if (
        candidate &&
        ts.isFunctionLike(candidate) &&
        "body" in candidate &&
        candidate.body &&
        this.#origin(candidate, argument) === null
      ) {
        return candidate;
      }
    }
    return null;
  }

  pointFreeSignatures(argument: ts.Expression, hostCall: HostCall) {
    const unwrapped = unwrapExpression(argument);
    if (ts.isFunctionLike(unwrapped)) {
      return [];
    }
    if (ts.isCallExpression(unwrapped)) {
      const declaration =
        this.#checker.getResolvedSignature(unwrapped)?.declaration;
      if (
        !declaration ||
        (this.#origin(declaration, hostCall) === null &&
          "body" in declaration &&
          declaration.body)
      ) {
        return [];
      }
      const declared = this.#checker.getSignatureFromDeclaration(declaration);
      const returned =
        declared && this.#checker.getReturnTypeOfSignature(declared);
      return returned?.getNonNullableType().getCallSignatures() ?? [];
    }
    if (
      ts.isIdentifier(unwrapped) ||
      ts.isPropertyAccessExpression(unwrapped)
    ) {
      return this.#symbolSignatures(unwrapped, hostCall);
    }
    return [];
  }

  #symbolSignatures(
    reference: ts.Identifier | ts.PropertyAccessExpression,
    hostCall: HostCall
  ) {
    const target = aliasTarget(
      this.#checker,
      this.#checker.getSymbolAtLocation(reference)
    );
    const declaration = target?.declarations?.[0];
    if (
      !target ||
      !declaration ||
      (this.#origin(declaration, hostCall) === null &&
        "body" in declaration &&
        declaration.body)
    ) {
      return [];
    }
    const declaredType =
      (ts.hasType(declaration) && declaration.type
        ? this.#checker.getTypeFromTypeNode(declaration.type)
        : undefined) ?? this.#checker.getTypeOfSymbol(target);
    return declaredType.getNonNullableType().getCallSignatures();
  }
}
