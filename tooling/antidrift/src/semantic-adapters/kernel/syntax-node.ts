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

export function fieldOf(candidate: unknown, field: string): unknown {
  return typeof candidate === "object" && candidate !== null
    ? Reflect.get(candidate, field)
    : undefined;
}

export function isSyntaxTypeIn(
  candidate: unknown,
  types: ReadonlySet<string>
): candidate is SyntaxNode {
  return isSyntaxNode(candidate) && types.has(candidate.type);
}

export function syntaxField(node: unknown, field: string): unknown {
  return isSyntaxNode(node) ? fieldOf(node, field) : undefined;
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

const TRANSPARENT_EXPRESSION_TYPES = new Set([
  "TSAsExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
]);

export function unwrapExpression(expression: unknown): unknown {
  if (isSyntaxType(expression, "ChainExpression")) {
    return syntaxField(expression, "expression");
  }
  if (isSyntaxTypeIn(expression, TRANSPARENT_EXPRESSION_TYPES)) {
    return unwrapExpression(syntaxField(expression, "expression"));
  }
  return expression;
}

function quasiText(quasi: unknown): string {
  const quasiForms = fieldOf(quasi, "value");
  const cooked = fieldOf(quasiForms, "cooked");
  if (typeof cooked === "string") {
    return cooked;
  }
  const raw = fieldOf(quasiForms, "raw");
  return typeof raw === "string" ? raw : "";
}

export function templateQuasiTexts(template: unknown): readonly string[] {
  const quasis: unknown = fieldOf(template, "quasis");
  if (!Array.isArray(quasis)) {
    return [];
  }
  const elements: readonly unknown[] = quasis;
  return elements.map((quasi) => quasiText(quasi));
}
