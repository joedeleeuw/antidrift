export {
  MIN_PROPS,
  collectAcceptedPackageCanonicalTypes,
  collectCanonicalTypes,
  collectDomainCanonicalTypes,
  collectGeneratedCanonicalTypes,
  isObjectType,
  resolvesToDomainCanonicalType,
  resolvesToGeneratedType,
  resolvesToInstalledType,
  typeProps,
} from "../policy/lib/type-index.mjs";

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
  let cur = node?.parent;
  while (cur) {
    if (cur.type === "TSPropertySignature") {
      return statusPropertyContextMatches(cur, statusName);
    }
    const contextName = statusContextNodeName(cur);
    if (contextName !== null) return isStatusContextName(contextName, statusName);
    cur = cur.parent;
  }
  return false;
}

function enclosingTypeDeclarationName(node) {
  let cur = node?.parent;
  while (cur) {
    if (cur.type === "TSTypeAliasDeclaration") return cur.id?.name ?? "";
    if (cur.type === "TSInterfaceDeclaration") return cur.id?.name ?? "";
    cur = cur.parent;
  }
  return "";
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
