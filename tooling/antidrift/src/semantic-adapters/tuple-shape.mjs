const TS_TYPE_FLAG_UNDEFINED = 1 << 15;
const TS_TYPE_FLAG_NULL = 1 << 16;

export function typeIncludesNullish(type, seen = new Set()) {
  if (!type || seen.has(type)) return false;
  seen.add(type);
  if (type.flags & (TS_TYPE_FLAG_NULL | TS_TYPE_FLAG_UNDEFINED)) return true;
  return (type.types ?? []).some((part) => typeIncludesNullish(part, seen));
}

export function tupleElementTypeNode(element) {
  if (element?.type === "TSNamedTupleMember") return element.elementType;
  if (element?.type === "TSOptionalType") return element.typeAnnotation;
  if (element?.type === "TSRestType") return element.typeAnnotation;
  return element;
}

export function tupleElementIsOptional(element) {
  return (
    element?.optional === true ||
    element?.type === "TSOptionalType" ||
    (element?.type === "TSNamedTupleMember" &&
      element.elementType?.type === "TSOptionalType")
  );
}

export function typeNodeIncludesDirectNullish(typeNode) {
  const node = tupleElementTypeNode(typeNode);
  if (
    node?.type === "TSNullKeyword" ||
    node?.type === "TSUndefinedKeyword" ||
    node?.type === "TSVoidKeyword"
  ) {
    return true;
  }
  if (node?.type === "TSUnionType") {
    return node.types.some(typeNodeIncludesDirectNullish);
  }
  if (node?.type === "TSParenthesizedType") {
    return typeNodeIncludesDirectNullish(node.typeAnnotation);
  }
  return false;
}

export function tupleElementResolvesToNullish(element, services, checker) {
  const typeNode = tupleElementTypeNode(element);
  const tsTypeNode = typeNode && services?.esTreeNodeToTSNodeMap?.get(typeNode);
  if (!tsTypeNode || !checker) return false;
  return typeIncludesNullish(checker.getTypeFromTypeNode(tsTypeNode));
}

export function tupleElementIsNullishSlot(element, services, checker) {
  return (
    tupleElementIsOptional(element) ||
    typeNodeIncludesDirectNullish(element) ||
    tupleElementResolvesToNullish(element, services, checker)
  );
}

export function nullableTupleSlots(node, services, checker) {
  return (node?.elementTypes ?? []).filter((element) =>
    tupleElementIsNullishSlot(element, services, checker),
  );
}

export function hasNullablePositionalTuple(
  node,
  services,
  checker,
  threshold = 2,
) {
  return nullableTupleSlots(node, services, checker).length >= threshold;
}
