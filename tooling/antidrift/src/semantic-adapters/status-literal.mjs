export function normalizedContextName(value) {
  return String(value ?? "")
    .replace(/[^a-z0-9]/giu, "")
    .toLowerCase();
}

export function isStatusContextName(contextName, statusName) {
  const normalized = normalizedContextName(contextName);
  return Boolean(
    normalized && normalized === normalizedContextName(statusName),
  );
}

export function nodeKeyName(node) {
  if (node?.type === "Identifier" || node?.type === "PrivateIdentifier") {
    return node.name;
  }
  if (node?.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  return "";
}

function statusContextNodeName(node) {
  if (node?.type === "TSTypeAliasDeclaration") return node.id?.name ?? "";
  if (node?.type === "TSInterfaceDeclaration") return node.id?.name ?? "";
  if (node?.type === "Identifier") return node.name;
  if (node?.type === "VariableDeclarator" && node.id?.type === "Identifier") {
    return node.id.name;
  }
  return null;
}

function enclosingTypeDeclarationName(node) {
  let current = node?.parent;
  while (current) {
    if (current.type === "TSTypeAliasDeclaration") {
      return current.id?.name ?? "";
    }
    if (current.type === "TSInterfaceDeclaration") {
      return current.id?.name ?? "";
    }
    current = current.parent;
  }
  return "";
}

function statusPropertyContextMatches(node, statusName) {
  const keyName = nodeKeyName(node?.key);
  if (isStatusContextName(keyName, statusName)) return true;
  const ownerName = enclosingTypeDeclarationName(node);
  return (
    Boolean(ownerName) &&
    normalizedContextName(`${ownerName}${keyName}`) ===
      normalizedContextName(statusName)
  );
}

export function isStatusLiteralContext(node, statusName) {
  let current = node?.parent;
  while (current) {
    if (current.type === "TSPropertySignature") {
      return statusPropertyContextMatches(current, statusName);
    }
    const contextName = statusContextNodeName(current);
    if (contextName !== null) {
      return isStatusContextName(contextName, statusName);
    }
    current = current.parent;
  }
  return false;
}

export function canonicalStatusLiteralOwner(node, statuses) {
  const value = node?.literal?.value;
  if (typeof value !== "string" || !statuses) return null;
  for (const [name, entry] of Object.entries(statuses)) {
    const values = Array.isArray(entry?.values) ? entry.values : [];
    if (!values.includes(value)) continue;
    if (!isStatusLiteralContext(node, name)) continue;
    return {
      name,
      owner: entry.owner,
      values,
      value,
    };
  }
  return null;
}
