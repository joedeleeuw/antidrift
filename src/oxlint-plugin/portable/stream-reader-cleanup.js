import { isAstNode, isIdentifier } from "./ast.js";
import {
  callWithinExpressionStatement,
  isDescendantOf,
  statementSite,
  staticMemberName,
  unwrapReaderExpression,
} from "./stream-reader-ast.js";

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

class ReaderCleanupPrefix {
  constructor(analysis) {
    this.analysis = analysis;
  }
  canRead = (identifier) => {
    const resolvedBinding = this.analysis.resolveVariable(identifier);
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
  cannotThrow = (node) => {
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
        (element) => element === null || this.cannotThrow(element)
      );
    }
    if (expression.type === "ObjectExpression") {
      return expression.properties.every(
        (property) =>
          property.type === "Property" &&
          property.kind === "init" &&
          property.computed !== true &&
          this.cannotThrow(property.value)
      );
    }
    return isIdentifier(expression) && this.canRead(expression);
  };
  allows = (statement) => {
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
            (declaration.init === null || this.cannotThrow(declaration.init))
        )
      );
    }
    if (statement.type !== "ExpressionStatement") {
      return false;
    }
    const expression = unwrapReaderExpression(statement.expression);
    return (
      this.analysis.allowAssignments === true &&
      expression?.type === "AssignmentExpression" &&
      expression.operator === "=" &&
      isIdentifier(expression.left) &&
      canWriteBinding(this.analysis.resolveVariable, expression.left) &&
      this.cannotThrow(expression.right)
    );
  };
}

export function canPrecedeReaderCleanup(statements, analysis) {
  return statements.every(new ReaderCleanupPrefix(analysis).allows);
}

export class ReaderCleanup {
  constructor(reader) {
    this.reader = reader;
  }
  methodStatementIndexes = (block, method, binding) => {
    if (
      !isAstNode(block) ||
      block.type !== "BlockStatement" ||
      !Array.isArray(block.body)
    ) {
      return [];
    }
    const indexes = [];
    for (const [index, statement] of block.body.entries()) {
      if (
        callWithinExpressionStatement(
          statement,
          (candidate) =>
            this.reader.readerMethodCall(candidate, method, binding),
          this.reader.canAssign
        )
      ) {
        indexes.push(index);
      }
    }
    return indexes;
  };

  handledCancelStatement = (statement, binding) => {
    if (!isAstNode(statement) || statement.type !== "ExpressionStatement") {
      return false;
    }
    let expression = unwrapReaderExpression(statement.expression);
    while (
      expression?.type === "AwaitExpression" ||
      (expression?.type === "AssignmentExpression" &&
        expression.operator === "=" &&
        isIdentifier(expression.left) &&
        this.reader.canAssign(expression.left))
    ) {
      const innerExpression =
        expression.type === "AwaitExpression"
          ? expression.argument
          : expression.right;
      expression = unwrapReaderExpression(innerExpression);
    }
    if (expression?.type !== "CallExpression") {
      return false;
    }
    const callee = unwrapReaderExpression(expression.callee);
    return (
      callee?.type === "MemberExpression" &&
      staticMemberName(callee) === "catch" &&
      this.reader.readerMethodCall(callee.object, "cancel", binding) !== null
    );
  };

  finalizerCleanup = (block, binding) => {
    if (
      !isAstNode(block) ||
      block.type !== "BlockStatement" ||
      !Array.isArray(block.body)
    ) {
      return { cancelBeforeRelease: false, releases: false };
    }
    let handledCancel = false;
    for (const statement of block.body) {
      if (
        callWithinExpressionStatement(
          statement,
          (candidate) =>
            this.reader.readerMethodCall(candidate, "releaseLock", binding),
          this.reader.canAssign
        )
      ) {
        return {
          cancelBeforeRelease: handledCancel,
          releases: true,
        };
      }
      if (
        callWithinExpressionStatement(
          statement,
          (candidate) =>
            this.reader.readerMethodCall(candidate, "cancel", binding),
          this.reader.canAssign
        )
      ) {
        if (!this.handledCancelStatement(statement, binding)) {
          return { cancelBeforeRelease: false, releases: false };
        }
        handledCancel = true;
        continue;
      }
      return this.nestedFinalizerCleanup(statement, binding, handledCancel);
    }
    return { cancelBeforeRelease: false, releases: false };
  };

  nestedFinalizerCleanup = (statement, binding, handledCancel) => {
    if (
      isAstNode(statement) &&
      statement.type === "TryStatement" &&
      isAstNode(statement.finalizer)
    ) {
      const nested = this.finalizerCleanup(statement.finalizer, binding);
      if (nested.releases) {
        const tryCancels =
          this.methodStatementIndexes(statement.block, "cancel", binding)
            .length > 0;
        return {
          cancelBeforeRelease:
            handledCancel || tryCancels || nested.cancelBeforeRelease,
          releases: true,
        };
      }
    }
    return { cancelBeforeRelease: false, releases: false };
  };

  tryCoversAcquisition = (tryNode, acquisition) => {
    if (isDescendantOf(acquisition.node, tryNode.block)) {
      return true;
    }
    const acquisitionSite = statementSite(acquisition.node);
    const trySite = statementSite(tryNode);
    if (
      acquisitionSite === null ||
      trySite === null ||
      acquisitionSite.block !== trySite.block ||
      !Array.isArray(acquisitionSite.block.body)
    ) {
      return false;
    }
    const acquisitionIndex = acquisitionSite.block.body.indexOf(
      acquisitionSite.statement
    );
    const tryIndex = acquisitionSite.block.body.indexOf(trySite.statement);
    return (
      acquisitionIndex !== -1 &&
      tryIndex > acquisitionIndex &&
      canPrecedeReaderCleanup(
        acquisitionSite.block.body.slice(acquisitionIndex + 1, tryIndex),
        {
          resolveVariable: this.reader.resolveVariable,
        }
      )
    );
  };
}
