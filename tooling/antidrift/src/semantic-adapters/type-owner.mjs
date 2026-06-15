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
  if (!normalized) return false;
  return (
    normalized.includes("status") ||
    normalized === normalizedContextName(statusName)
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

export function isStatusLiteralContext(node, statusName) {
  let cur = node?.parent;
  while (cur) {
    if (cur.type === "TSTypeAliasDeclaration") {
      return isStatusContextName(cur.id?.name, statusName);
    }
    if (cur.type === "TSInterfaceDeclaration") {
      return isStatusContextName(cur.id?.name, statusName);
    }
    if (cur.type === "TSPropertySignature") {
      return isStatusContextName(nodeKeyName(cur.key), statusName);
    }
    if (cur.type === "Identifier") {
      return isStatusContextName(cur.name, statusName);
    }
    if (cur.type === "VariableDeclarator" && cur.id?.type === "Identifier") {
      return isStatusContextName(cur.id.name, statusName);
    }
    cur = cur.parent;
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
