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

const MAP_WRAPPER_NAMES = new Set(["Readonly", "Partial", "Required"]);
const ABSENT_TYPE_KINDS = new Set(["TSUndefinedKeyword", "TSNullKeyword"]);

function unwrapMapKeyType(typeNode) {
  let current = typeNode;
  for (let step = 0; current && step < 8; step += 1) {
    if (current.type === "TSUnionType") {
      const present = current.types.filter(
        (member) => !ABSENT_TYPE_KINDS.has(member.type)
      );
      if (present.length !== 1) return null;
      current = present[0];
      continue;
    }
    if (
      current.type === "TSTypeReference" &&
      current.typeName?.type === "Identifier" &&
      MAP_WRAPPER_NAMES.has(current.typeName.name) &&
      current.typeArguments?.params?.length === 1
    ) {
      current = current.typeArguments.params[0];
      continue;
    }
    return current;
  }
  return null;
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
  const typeNode = unwrapMapKeyType(member.typeAnnotation?.typeAnnotation);
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
