import {
  identifierName,
  isSyntaxNode,
  isSyntaxType,
  isSyntaxTypeIn,
  syntaxChildren,
  syntaxField,
} from "../kernel/syntax-node.ts";

const CAST_WRAPPER_TYPES = new Set([
  "TSAsExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
  "ChainExpression",
]);

export function unwrapCasts(node: unknown) {
  let current = node;
  while (isSyntaxTypeIn(current, CAST_WRAPPER_TYPES)) {
    current = syntaxField(current, "expression");
  }
  return current;
}

export function memberName(node: unknown): string {
  return syntaxField(node, "computed") === true
    ? ""
    : (identifierName(syntaxField(node, "property")) ?? "");
}

function staticMemberName(node: unknown): string {
  if (syntaxField(node, "computed") !== true) {
    return memberName(node);
  }
  const property = unwrapCasts(syntaxField(node, "property"));
  const key = syntaxField(property, "value");
  return isSyntaxType(property, "Literal") &&
    (typeof key === "string" || typeof key === "number")
    ? String(key)
    : "";
}

export function castIdentifierName(node: unknown): string {
  return identifierName(unwrapCasts(node)) ?? "";
}

export function parameterNames(functionNode: unknown): Set<string> {
  return new Set(
    syntaxChildren(functionNode, "params")
      .map((parameter) => castIdentifierName(parameter))
      .filter((name) => name.length > 0)
  );
}

function baseIdentifierName(node: unknown): string {
  const unwrapped = unwrapCasts(node);
  if (isSyntaxType(unwrapped, "MemberExpression")) {
    return baseIdentifierName(syntaxField(unwrapped, "object"));
  }
  return identifierName(unwrapped) ?? "";
}

export function importedName(specifier: unknown): string {
  const imported = syntaxField(specifier, "imported");
  if (isSyntaxType(imported, "Literal")) {
    return String(syntaxField(imported, "value"));
  }
  return identifierName(imported) ?? "";
}

export function sourceMemberWrite(
  argument: unknown,
  awaitedNames: ReadonlySet<string>
) {
  const member = unwrapCasts(argument);
  const source = identifierName(unwrapCasts(syntaxField(member, "object")));
  const property = staticMemberName(member);
  if (
    !isSyntaxType(member, "MemberExpression") ||
    !source ||
    !property ||
    !awaitedNames.has(source)
  ) {
    return null;
  }
  return { source, property };
}

const PARAMETER_DERIVED_CHILDREN = new Map<
  string,
  (node: unknown) => readonly unknown[]
>([
  ["CallExpression", (node) => syntaxChildren(node, "arguments")],
  ["TemplateLiteral", (node) => syntaxChildren(node, "expressions")],
  [
    "LogicalExpression",
    (node) => [syntaxField(node, "left"), syntaxField(node, "right")],
  ],
  [
    "BinaryExpression",
    (node) => [syntaxField(node, "left"), syntaxField(node, "right")],
  ],
  [
    "ConditionalExpression",
    (node) => [
      syntaxField(node, "test"),
      syntaxField(node, "consequent"),
      syntaxField(node, "alternate"),
    ],
  ],
]);

export function isParameterDerived(
  node: unknown,
  names: ReadonlySet<string>
): boolean {
  const unwrapped = unwrapCasts(node);
  if (isSyntaxType(unwrapped, "Identifier")) {
    return names.has(identifierName(unwrapped) ?? "");
  }
  if (isSyntaxType(unwrapped, "MemberExpression")) {
    return names.has(baseIdentifierName(syntaxField(unwrapped, "object")));
  }
  const children = isSyntaxNode(unwrapped)
    ? PARAMETER_DERIVED_CHILDREN.get(unwrapped.type)?.(unwrapped)
    : undefined;
  return (children ?? []).some((child) => isParameterDerived(child, names));
}
