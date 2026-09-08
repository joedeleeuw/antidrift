import { isRuleFile, scopeProperties } from "./scope.js";
import {
  getPropertyName,
  isAstNode,
  isCallTo,
  isIdentifier,
  unwrapExpression,
} from "./ast.js";

const RAW_INPUT_OBJECTS = new Set(["file", "body", "query", "part"]);
const RAW_NAME_PROPS = new Set(["name", "filename", "fileName"]);

export default {
  meta: {
    schema: [
      {
        type: "object",
        properties: scopeProperties,
        additionalProperties: false,
      },
    ],

    type: "problem",
    messages: {
      rawFilename:
        "Use sanitizeFilename() before assigning to " +
        "fileName. Raw strings may contain path " +
        "traversal segments.",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};

    const resolveVariable = (identifier) => {
      let scope = context.sourceCode.getScope(identifier);
      while (scope !== null) {
        const variable = scope.set.get(identifier.name);
        if (variable !== undefined) {
          return variable;
        }
        scope = scope.upper;
      }
      return null;
    };
    const isRawDestructuredFilename = (declaration, identifierName) => {
      const init = unwrapExpression(declaration.init);
      if (
        !isIdentifier(init) ||
        !RAW_INPUT_OBJECTS.has(init.name) ||
        declaration.id.type !== "ObjectPattern"
      ) {
        return false;
      }
      return declaration.id.properties.some((property) => {
        if (property.type !== "Property") {
          return false;
        }
        const boundValue =
          property.value.type === "AssignmentPattern"
            ? property.value.left
            : property.value;
        return (
          RAW_NAME_PROPS.has(getPropertyName(property.key) ?? "") &&
          isIdentifier(boundValue, identifierName)
        );
      });
    };
    const isRawFilenameExpression = (node, seenVariables = new Set()) => {
      const expression = unwrapExpression(node);
      if (!isAstNode(expression)) {
        return false;
      }
      if (isCallTo(expression, "sanitizeFilename")) {
        return false;
      }
      if (
        expression.type === "MemberExpression" &&
        expression.computed === false &&
        isIdentifier(expression.object) &&
        isIdentifier(expression.property) &&
        RAW_INPUT_OBJECTS.has(expression.object.name) &&
        RAW_NAME_PROPS.has(expression.property.name)
      ) {
        return true;
      }
      if (
        expression.type === "TemplateLiteral" &&
        Array.isArray(expression.expressions)
      ) {
        return expression.expressions.some((part) =>
          isRawFilenameExpression(part, seenVariables),
        );
      }
      if (
        expression.type === "BinaryExpression" ||
        expression.type === "LogicalExpression"
      ) {
        return (
          isRawFilenameExpression(expression.left, seenVariables) ||
          isRawFilenameExpression(expression.right, seenVariables)
        );
      }
      if (expression.type === "ConditionalExpression") {
        return (
          isRawFilenameExpression(expression.consequent, seenVariables) ||
          isRawFilenameExpression(expression.alternate, seenVariables)
        );
      }
      if (!isIdentifier(expression)) {
        return false;
      }
      const variable = resolveVariable(expression);
      if (variable === null || seenVariables.has(variable)) {
        return false;
      }
      const nextSeenVariables = new Set(seenVariables);
      nextSeenVariables.add(variable);
      return variable.defs.some((definition) => {
        const declaration = definition.node;
        if (declaration.type !== "VariableDeclarator") {
          return false;
        }
        return (
          isRawDestructuredFilename(declaration, expression.name) ||
          isRawFilenameExpression(declaration.init, nextSeenVariables)
        );
      });
    };
    return {
      Property(node) {
        if (getPropertyName(node.key) !== "fileName") {
          return;
        }
        if (isRawFilenameExpression(node.value)) {
          context.report({ node, messageId: "rawFilename" });
        }
      },
    };
  },
};
