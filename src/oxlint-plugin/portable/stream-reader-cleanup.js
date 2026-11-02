import { isAstNode, isIdentifier } from "./ast.js";
import { unwrapReaderExpression } from "./stream-reader-ast.js";

const followsDeclaration = (identifier, definition) =>
  Array.isArray(identifier.range) &&
  Array.isArray(definition.node.range) &&
  identifier.range[0] >= definition.node.range[1];

export function canWriteBinding(resolveVariable, identifier) {
  if (!isIdentifier(identifier)) {
    return false;
  }
  const resolvedBinding = resolveVariable(identifier);
  return (
    resolvedBinding !== null &&
    resolvedBinding.defs.length > 0 &&
    resolvedBinding.defs.every((definition) => {
      if (
        definition.type === "Parameter" ||
        definition.type === "CatchClause"
      ) {
        return true;
      }
      if (
        definition.type !== "Variable" ||
        !isAstNode(definition.node) ||
        !isAstNode(definition.parent)
      ) {
        return false;
      }
      if (definition.parent.kind === "var") {
        return true;
      }
      return (
        definition.parent.kind === "let" &&
        followsDeclaration(identifier, definition)
      );
    })
  );
}

export function canPrecedeReaderCleanup(statements, analysis) {
  const canRead = (identifier) => {
    const resolvedBinding = analysis.resolveVariable(identifier);
    return (
      resolvedBinding !== null &&
      resolvedBinding.defs.length > 0 &&
      resolvedBinding.defs.every((definition) => {
        if (
          definition.type === "Parameter" ||
          definition.type === "CatchClause"
        ) {
          return true;
        }
        if (
          definition.type !== "Variable" ||
          !isAstNode(definition.node) ||
          !isAstNode(definition.parent)
        ) {
          return false;
        }
        return (
          definition.parent.kind === "var" ||
          ((definition.parent.kind === "let" ||
            definition.parent.kind === "const") &&
            followsDeclaration(identifier, definition))
        );
      })
    );
  };
  const cannotThrow = (node) => {
    const expression = unwrapReaderExpression(node);
    if (expression === null) {
      return false;
    }
    if (expression.type === "Literal") {
      return true;
    }
    if (
      expression.type === "ArrowFunctionExpression" ||
      expression.type === "FunctionExpression"
    ) {
      return true;
    }
    if (expression.type === "TemplateLiteral") {
      return expression.expressions.length === 0;
    }
    if (expression.type === "ArrayExpression") {
      return expression.elements.every(
        (element) => element === null || cannotThrow(element)
      );
    }
    if (expression.type === "ObjectExpression") {
      return expression.properties.every(
        (property) =>
          property.type === "Property" &&
          property.kind === "init" &&
          property.computed !== true &&
          cannotThrow(property.value)
      );
    }
    return isIdentifier(expression) && canRead(expression);
  };
  return statements.every((statement) => {
    if (!isAstNode(statement)) {
      return false;
    }
    if (statement.type === "VariableDeclaration") {
      return (
        (statement.kind === "const" ||
          statement.kind === "let" ||
          statement.kind === "var") &&
        Array.isArray(statement.declarations) &&
        statement.declarations.every(
          (declaration) =>
            isAstNode(declaration) &&
            declaration.type === "VariableDeclarator" &&
            isIdentifier(declaration.id) &&
            (declaration.init === null || cannotThrow(declaration.init))
        )
      );
    }
    if (statement.type !== "ExpressionStatement") {
      return false;
    }
    const expression = unwrapReaderExpression(statement.expression);
    return (
      analysis.allowAssignments === true &&
      expression?.type === "AssignmentExpression" &&
      expression.operator === "=" &&
      isIdentifier(expression.left) &&
      canWriteBinding(analysis.resolveVariable, expression.left) &&
      cannotThrow(expression.right)
    );
  });
}
