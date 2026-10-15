import ts from "typescript";
import { aliasTarget, unknownProvenance } from "./boundary-summaries.mjs";
import { enclosingFunction } from "./boundary-syntax.mjs";

function bindsThisToClass(ancestor) {
  if (ts.isArrowFunction(ancestor)) return true;
  if (ts.isMethodDeclaration(ancestor) || ts.isAccessor(ancestor)) {
    return !ts.isObjectLiteralExpression(ancestor.parent);
  }
  return ts.isConstructorDeclaration(ancestor);
}

function enclosingClass(node) {
  let ancestor = node.parent;
  while (ancestor && !ts.isClassLike(ancestor)) {
    if (ts.isFunctionLike(ancestor) && !bindsThisToClass(ancestor)) {
      return null;
    }
    ancestor = ancestor.parent;
  }
  return ancestor ?? null;
}

function isThisWrite(node) {
  return (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isPropertyAccessExpression(node.left) &&
    node.left.expression.kind === ts.SyntaxKind.ThisKeyword
  );
}

function thisReceiverParameter(expression) {
  let ancestor = enclosingFunction(expression);
  while (ancestor && ts.isArrowFunction(ancestor)) {
    ancestor = enclosingFunction(ancestor);
  }
  return ancestor?.parameters.find(
    (parameter) =>
      ts.isIdentifier(parameter.name) && parameter.name.text === "this"
  );
}

export function classReceivers({
  checker,
  origin,
  propertyKeys,
  trace,
  summary,
  parameterRoots,
  prefixed,
}) {
  function classFieldRoots(classDeclaration) {
    const roots = [];
    function fieldWrite(keys, expression) {
      for (const key of keys ?? []) {
        roots.push(
          ...trace(expression).map((root) => prefixed(root, key, expression))
        );
      }
    }
    for (const member of classDeclaration.members) {
      if (ts.isPropertyDeclaration(member) && member.initializer) {
        fieldWrite(propertyKeys(member), member.initializer);
      }
      if (ts.isConstructorDeclaration(member)) {
        for (const parameter of member.parameters) {
          if (
            ts.isIdentifier(parameter.name) &&
            ts.getCombinedModifierFlags(parameter) &
              ts.ModifierFlags.ParameterPropertyModifier
          ) {
            roots.push(
              ...parameterRoots(parameter).map((root) =>
                prefixed(root, parameter.name.text, parameter)
              )
            );
          }
        }
      }
    }
    function visit(node) {
      if (isThisWrite(node)) fieldWrite([node.left.name.text], node.right);
      ts.forEachChild(node, visit);
    }
    for (const member of classDeclaration.members) visit(member);
    return roots;
  }

  function thisRoots(expression) {
    const owner = enclosingClass(expression);
    if (owner) return summary(owner);
    const receiver = thisReceiverParameter(expression);
    if (receiver) return parameterRoots(receiver);
    return unknownProvenance(expression, "this receiver outside a class");
  }

  function superRoots(expression) {
    const owner = enclosingClass(expression);
    const heritage = owner?.heritageClauses?.find(
      (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword
    );
    const base = heritage?.types[0]?.expression;
    const target =
      base && aliasTarget(checker, checker.getSymbolAtLocation(base));
    const declaration = target?.declarations?.find(ts.isClassLike);
    if (!declaration || origin(declaration, expression) !== null) {
      return unknownProvenance(expression, "super of an unresolved class");
    }
    return summary(declaration);
  }

  return { classFieldRoots, superRoots, thisRoots };
}
