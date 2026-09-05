import { findVariable } from "./imported-owner.js";

export function isClassValue(node, context, seen = new Set()) {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type === "VariableDeclarator") {
      const variable = findVariable(context, current.id);
      if (!variable || seen.has(variable)) return false;
      seen.add(variable);
      return variable.references.some(
        (reference) =>
          reference.isRead() &&
          isClassValue(reference.identifier, context, new Set(seen)),
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
