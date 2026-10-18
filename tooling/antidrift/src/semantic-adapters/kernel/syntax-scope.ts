import type { SyntaxNode } from "./syntax-node.ts";

type DeclaredVariableSource = {
  getDeclaredVariables(node: SyntaxNode): unknown;
};

type ScopeSource = {
  getScope(node: SyntaxNode): unknown;
};

type LexicalScope = {
  readonly set: ReadonlyMap<string, unknown>;
  readonly upper: unknown;
};

function isDeclaredVariableSource(
  candidate: unknown
): candidate is DeclaredVariableSource {
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    typeof Reflect.get(candidate, "getDeclaredVariables") === "function"
  );
}

function isScopeSource(candidate: unknown): candidate is ScopeSource {
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    typeof Reflect.get(candidate, "getScope") === "function"
  );
}

function isLexicalScope(candidate: unknown): candidate is LexicalScope {
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    Reflect.get(candidate, "set") instanceof Map &&
    "upper" in candidate
  );
}

export function declaredVariables(
  variableSource: unknown,
  node: SyntaxNode
): readonly unknown[] {
  if (!isDeclaredVariableSource(variableSource)) {
    return [];
  }
  const variables = variableSource.getDeclaredVariables(node);
  if (!Array.isArray(variables)) {
    return [];
  }
  return variables;
}

export function variableName(binding: unknown): string | null {
  if (typeof binding !== "object" || binding === null) {
    return null;
  }
  const name: unknown = Reflect.get(binding, "name");
  return typeof name === "string" ? name : null;
}

export function resolveVariable(
  sourceCode: unknown,
  reference: SyntaxNode,
  name: string
) {
  if (!isScopeSource(sourceCode)) {
    return null;
  }
  let scope = sourceCode.getScope(reference);
  while (isLexicalScope(scope)) {
    const binding = scope.set.get(name);
    if (binding) {
      return binding;
    }
    scope = scope.upper;
  }
  return null;
}
