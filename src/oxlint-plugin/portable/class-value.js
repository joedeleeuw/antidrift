import { findVariable } from "../shared/scope.js";

function isClassExpression(node, context, seen = new Set()) {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type === "VariableDeclarator") {
      const binding = findVariable(context.sourceCode, current.id);
      if (!binding || seen.has(binding)) return false;
      seen.add(binding);
      return binding.references.some(
        (reference) =>
          reference.isRead() &&
          isClassExpression(reference.identifier, context, new Set(seen))
      );
    }
    if (current.type === "JSXAttribute") {
      return current.name.name === "className";
    }
    if (
      current.type === "Property" &&
      (current.key.name ?? current.key.value) === "className"
    ) {
      return true;
    }
    if (current.type === "CallExpression") {
      return ["clsx", "cn", "cva", "twMerge"].includes(current.callee.name);
    }
    if (
      ![
        "TemplateLiteral",
        "JSXExpressionContainer",
        "ConditionalExpression",
        "LogicalExpression",
        "BinaryExpression",
        "ArrayExpression",
      ].includes(current.type)
    ) {
      return false;
    }
  }
  return false;
}

export function classValueVisitors(context, onClassString) {
  return {
    Literal(node) {
      if (typeof node.value === "string" && isClassExpression(node, context)) {
        onClassString(node, node.value);
      }
    },
    TemplateElement(node) {
      if (isClassExpression(node, context)) {
        onClassString(node, node.value.raw);
      }
    },
  };
}
