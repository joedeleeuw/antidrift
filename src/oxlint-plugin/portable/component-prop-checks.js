import { functionReturnsJsx } from "../shared/scope.js";
import {
  collectTypePropertyNames,
  recordProgramTypeDeclarations,
} from "./parameter-bag-checks.js";

function hasWidgetDirective(fnNode) {
  if (fnNode?.body?.type !== "BlockStatement") return false;
  for (const stmt of fnNode.body.body) {
    if (stmt.type !== "ExpressionStatement") break;
    const dir =
      stmt.directive ??
      (stmt.expression?.type === "Literal" &&
      typeof stmt.expression.value === "string"
        ? stmt.expression.value
        : null);
    if (!dir) break;
    if (dir === "widget") return true;
  }
  return false;
}

function checkComponent(node, typeDeclarations, context) {
  if (
    !functionReturnsJsx(node) ||
    hasWidgetDirective(node) ||
    node.params.length === 0 ||
    node.params.length > 2
  ) {
    return;
  }
  const max = context.options[0]?.max ?? 12;
  const first = node.params[0];
  let propCount = 0;
  if (first.type === "ObjectPattern") {
    propCount = first.properties.filter(
      (property) => property.type === "Property"
    ).length;
  }
  const annotationCount = collectTypePropertyNames(
    first.typeAnnotation?.typeAnnotation,
    typeDeclarations
  ).size;
  const total = Math.max(propCount, annotationCount);
  if (total > max) {
    context.report({
      node: first,
      message: `Component accepts ${total} props (max ${max}); group cohesive props or compose children instead.`,
    });
  }
}

export function createComponentPropChecks(context) {
  const typeDeclarations = new Map();

  const check = (node) => checkComponent(node, typeDeclarations, context);

  return {
    Program(node) {
      recordProgramTypeDeclarations(node, typeDeclarations);
    },
    FunctionDeclaration: check,
    FunctionExpression: check,
    ArrowFunctionExpression: check,
  };
}
