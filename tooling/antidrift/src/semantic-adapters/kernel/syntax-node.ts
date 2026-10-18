export type SyntaxNode = { readonly type: string };

export function isSyntaxNode(candidate: unknown): candidate is SyntaxNode {
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    typeof Reflect.get(candidate, "type") === "string"
  );
}

export function isSyntaxType(
  candidate: unknown,
  type: string
): candidate is SyntaxNode {
  return isSyntaxNode(candidate) && candidate.type === type;
}

export function syntaxField(node: unknown, field: string): unknown {
  return isSyntaxNode(node) ? Reflect.get(node, field) : undefined;
}

export function syntaxChildren(
  node: unknown,
  field: string
): readonly unknown[] {
  const children = syntaxField(node, field);
  if (!Array.isArray(children)) {
    return [];
  }
  return children;
}

export function syntaxText(node: unknown, field: string): string | null {
  const text = syntaxField(node, field);
  return typeof text === "string" ? text : null;
}

export function identifierName(candidate: unknown): string | null {
  return isSyntaxType(candidate, "Identifier")
    ? syntaxText(candidate, "name")
    : null;
}
