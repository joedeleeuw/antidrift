import type { SyntaxNode } from "../kernel/syntax-node.ts";
import {
  fieldOf,
  isSyntaxNode,
  isSyntaxType,
  syntaxField,
  syntaxText,
} from "../kernel/syntax-node.ts";

export type DomainStatusEntry = {
  owner: string;
  values: readonly string[];
  valuesExport?: string;
};

export type DomainStatusRegistry = Record<string, DomainStatusEntry>;

export type StatusLiteralOwner = {
  name: string;
  owner: string;
  values: readonly string[];
  value: string;
};

const TYPE_DECLARATION_TYPES = new Set([
  "TSTypeAliasDeclaration",
  "TSInterfaceDeclaration",
]);

export function normalizedContextName(
  contextName: string | null | undefined
): string {
  return (contextName ?? "").replace(/[^a-z0-9]/giu, "").toLowerCase();
}

function matchesStatusKey(contextName: string, statusKey: string): boolean {
  const normalized = normalizedContextName(contextName);
  return normalized.length > 0 && normalized === statusKey;
}

export function isStatusContextName(
  contextName: string | null | undefined,
  statusName: string
): boolean {
  const normalized = normalizedContextName(contextName);
  return (
    normalized.length > 0 && normalized === normalizedContextName(statusName)
  );
}

export function nodeKeyName(node: unknown): string {
  if (
    isSyntaxType(node, "Identifier") ||
    isSyntaxType(node, "PrivateIdentifier")
  ) {
    return syntaxText(node, "name") ?? "";
  }
  const literal = syntaxField(node, "value");
  if (isSyntaxType(node, "Literal") && typeof literal === "string") {
    return literal;
  }
  return "";
}

function declaredName(node: SyntaxNode): string {
  const name = fieldOf(fieldOf(node, "id"), "name");
  return typeof name === "string" ? name : "";
}

function statusContextNodeName(node: SyntaxNode): string | null {
  if (TYPE_DECLARATION_TYPES.has(node.type)) {
    return declaredName(node);
  }
  if (node.type === "Identifier") {
    return syntaxText(node, "name") ?? "";
  }
  if (
    node.type === "VariableDeclarator" &&
    isSyntaxType(syntaxField(node, "id"), "Identifier")
  ) {
    return declaredName(node);
  }
  return null;
}

function enclosingTypeDeclarationName(node: SyntaxNode): string {
  for (
    let current = syntaxField(node, "parent");
    isSyntaxNode(current);
    current = syntaxField(current, "parent")
  ) {
    if (TYPE_DECLARATION_TYPES.has(current.type)) {
      return declaredName(current);
    }
  }
  return "";
}

function statusPropertyContextMatches(
  node: SyntaxNode,
  statusKey: string
): boolean {
  const keyName = nodeKeyName(syntaxField(node, "key"));
  if (matchesStatusKey(keyName, statusKey)) {
    return true;
  }
  const ownerName = enclosingTypeDeclarationName(node);
  return (
    ownerName.length > 0 &&
    normalizedContextName(`${ownerName}${keyName}`) === statusKey
  );
}

export function isStatusLiteralContext(
  node: unknown,
  statusName: string
): boolean {
  const statusKey = normalizedContextName(statusName);
  for (
    let current = syntaxField(node, "parent");
    isSyntaxNode(current);
    current = syntaxField(current, "parent")
  ) {
    if (current.type === "TSPropertySignature") {
      return statusPropertyContextMatches(current, statusKey);
    }
    const contextName = statusContextNodeName(current);
    if (contextName !== null) {
      return matchesStatusKey(contextName, statusKey);
    }
  }
  return false;
}

function statusLiterals(entry: unknown): readonly string[] {
  const declared = fieldOf(entry, "values");
  if (!Array.isArray(declared)) {
    return [];
  }
  return declared.filter((literal) => typeof literal === "string");
}

export function canonicalStatusLiteralOwner(
  node: unknown,
  statuses: unknown
): StatusLiteralOwner | null {
  const literalText = fieldOf(fieldOf(node, "literal"), "value");
  if (
    typeof literalText !== "string" ||
    typeof statuses !== "object" ||
    !statuses
  ) {
    return null;
  }
  for (const [name, entry] of Object.entries(statuses)) {
    const literals = statusLiterals(entry);
    if (literals.includes(literalText) && isStatusLiteralContext(node, name)) {
      const owner = fieldOf(entry, "owner");
      if (typeof owner !== "string") {
        throw new TypeError(`statuses.${name}.owner must be a string`);
      }
      return { name, owner, values: literals, value: literalText };
    }
  }
  return null;
}
