import {
  identifierName,
  isSyntaxNode,
  isSyntaxType,
  syntaxField,
  syntaxText,
} from "./syntax-node.ts";
import {
  declaredVariables,
  resolveVariable,
  variableName,
} from "./syntax-scope.ts";

export function getDeclaredVariable(sourceCode: unknown, declarator: unknown) {
  const name = identifierName(syntaxField(declarator, "id"));
  if (name === null || !isSyntaxNode(declarator)) {
    return null;
  }
  const scopeManager: unknown =
    typeof sourceCode === "object" && sourceCode !== null
      ? Reflect.get(sourceCode, "scopeManager")
      : undefined;
  return (
    declaredVariables(scopeManager, declarator).find(
      (binding) => variableName(binding) === name
    ) ?? null
  );
}

export function findVariable(sourceCode: unknown, identifier: unknown) {
  if (!isSyntaxType(identifier, "Identifier")) {
    return null;
  }
  const name = syntaxText(identifier, "name");
  return name === null ? null : resolveVariable(sourceCode, identifier, name);
}
