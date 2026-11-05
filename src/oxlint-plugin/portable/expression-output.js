import {
  findVariable,
  isFunctionLike,
  staticPropertyName,
} from "../shared/scope.js";

export function contributesToOutput(node, sourceCode, seen = new Set()) {
  for (let current = node; current?.parent; current = current.parent) {
    const parent = current.parent;
    if (parent.type === "ExpressionStatement") return false;
    if (
      parent.type === "ReturnStatement" ||
      parent.type === "AssignmentExpression"
    ) {
      return true;
    }
    if (isFunctionLike(parent)) return parent.body === current;
    if (parent.type === "CallExpression" && parent.callee === current) {
      return false;
    }
    if (
      parent.type === "CallExpression" &&
      staticPropertyName(parent.callee) === "push"
    ) {
      return true;
    }
    if (parent.type === "VariableDeclarator") {
      if (parent.id.type !== "Identifier") return false;
      const binding = findVariable(sourceCode, parent.id);
      if (!binding || seen.has(binding)) return false;
      seen.add(binding);
      return binding.references.some(
        (reference) =>
          reference.isRead() &&
          contributesToOutput(reference.identifier, sourceCode, seen)
      );
    }
  }
  return false;
}
