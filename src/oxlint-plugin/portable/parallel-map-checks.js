const MAP_TYPE_NAMES = new Set(["Map", "ReadonlyMap", "Record"]);
const GENERIC_BY_TARGETS = new Set(["Id", "Key", "ID", "Type", "Kind", "Name"]);
const STOP_PREFIXES = new Set([
  "active",
  "pending",
  "selected",
  "default",
  "initial",
  "current",
  "previous",
  "last",
  "next",
  "all",
  "raw",
  "should",
  "with",
  "from",
]);

function unwrapReadonlyType(typeNode) {
  if (
    typeNode?.type === "TSTypeReference" &&
    typeNode.typeName?.type === "Identifier" &&
    typeNode.typeName.name === "Readonly" &&
    typeNode.typeArguments?.params?.length === 1
  ) {
    return typeNode.typeArguments.params[0];
  }
  return typeNode;
}

function mapKeyTypeText(member, sourceCode) {
  if (
    (member.type !== "TSPropertySignature" &&
      member.type !== "PropertyDefinition") ||
    member.computed ||
    member.key?.type !== "Identifier"
  ) {
    return null;
  }
  const typeNode = unwrapReadonlyType(member.typeAnnotation?.typeAnnotation);
  if (
    typeNode?.type !== "TSTypeReference" ||
    typeNode.typeName?.type !== "Identifier" ||
    !MAP_TYPE_NAMES.has(typeNode.typeName.name)
  ) {
    return null;
  }
  const keyArg = typeNode.typeArguments?.params?.[0];
  if (!keyArg) return null;
  return sourceCode.getText(keyArg).replace(/\s+/gu, " ");
}

function cohortTagForField(fieldName) {
  const byMatch = /By([A-Z][A-Za-z0-9]*?)(?:Id|Key|ID)?$/u.exec(fieldName);
  if (byMatch) {
    const entity = byMatch[1];
    return GENERIC_BY_TARGETS.has(entity) ? null : `by:${entity}`;
  }
  const prefixMatch = /^([a-z]{4,})[A-Z]/u.exec(fieldName);
  if (!prefixMatch) return null;
  const prefix = prefixMatch[1];
  return STOP_PREFIXES.has(prefix) ? null : `prefix:${prefix}`;
}

export function checkParallelSidecarMaps(
  context,
  ownerName,
  members,
  reportNode
) {
  if (!Array.isArray(members) || members.length < 3) return;
  const groups = new Map();
  for (const member of members) {
    const keyType = mapKeyTypeText(member, context.sourceCode);
    if (!keyType) continue;
    const fieldName = member.key.name;
    const tag = cohortTagForField(fieldName);
    if (!tag) continue;
    const groupKey = `${keyType}::${tag}`;
    const existing = groups.get(groupKey) ?? { keyType, fields: [] };
    existing.fields.push(fieldName);
    groups.set(groupKey, existing);
  }
  for (const group of groups.values()) {
    if (group.fields.length >= 3) {
      const sample = group.fields.slice(0, 3).join(", ");
      context.report({
        node: reportNode,
        message: `Type '${ownerName}' declares ${group.fields.length} parallel map fields (${sample}) keyed by '${group.keyType}'; consolidate per-key state into a single Map or Record of a domain entry type.`,
      });
      return;
    }
  }
}
