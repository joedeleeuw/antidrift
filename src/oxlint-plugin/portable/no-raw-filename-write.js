import { isRuleFile, scopeProperties } from "../shared/rule-scope.js";
import { findVariable, unwrapExpression } from "../shared/scope.js";
import { getPropertyName, isAstNode, isCallTo, isIdentifier } from "./ast.js";

const RAW_INPUT_OBJECTS = new Set(["file", "body", "query", "part"]);
const RAW_NAME_PROPS = new Set(["name", "filename", "fileName"]);

class RawFilenameWrites {
  constructor(context) {
    this.context = context;
  }
  isRawDestructuredFilename = (declaration, identifierName) => {
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
      const boundIdentifier =
        property.value.type === "AssignmentPattern"
          ? property.value.left
          : property.value;
      return (
        RAW_NAME_PROPS.has(getPropertyName(property.key) ?? "") &&
        isIdentifier(boundIdentifier, identifierName)
      );
    });
  };

  isRawFilenameExpression = (node, seenVariables = new Set()) => {
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
        this.isRawFilenameExpression(part, seenVariables)
      );
    }
    if (
      expression.type === "BinaryExpression" ||
      expression.type === "LogicalExpression"
    ) {
      return (
        this.isRawFilenameExpression(expression.left, seenVariables) ||
        this.isRawFilenameExpression(expression.right, seenVariables)
      );
    }
    if (expression.type === "ConditionalExpression") {
      return (
        this.isRawFilenameExpression(expression.consequent, seenVariables) ||
        this.isRawFilenameExpression(expression.alternate, seenVariables)
      );
    }
    return this.isRawFilenameBinding(expression, seenVariables);
  };

  isRawFilenameBinding = (expression, seenVariables) => {
    if (!isIdentifier(expression)) {
      return false;
    }
    const binding = findVariable(this.context.sourceCode, expression);
    if (binding === null || seenVariables.has(binding)) {
      return false;
    }
    const nextSeenVariables = new Set(seenVariables);
    nextSeenVariables.add(binding);
    return binding.defs.some((definition) => {
      const declaration = definition.node;
      if (declaration.type !== "VariableDeclarator") {
        return false;
      }
      return (
        this.isRawDestructuredFilename(declaration, expression.name) ||
        this.isRawFilenameExpression(declaration.init, nextSeenVariables)
      );
    });
  };

  visitProperty = (node) => {
    if (getPropertyName(node.key) !== "fileName") {
      return;
    }
    if (this.isRawFilenameExpression(node.value)) {
      this.context.report({ node, messageId: "rawFilename" });
    }
  };
  listeners() {
    return {
      Property: this.visitProperty,
    };
  }
}

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
    return new RawFilenameWrites(context).listeners();
  },
};
