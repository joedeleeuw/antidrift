export const filenameForContext = (context) =>
  (context.filename ?? context.getFilename?.() ?? "").replaceAll("\\", "/");
export const isAstNode = (node) =>
  typeof node === "object" &&
  node !== null &&
  "type" in node &&
  typeof node.type === "string" &&
  "range" in node;
export const isIdentifier = (node, name) => {
  if (!isAstNode(node) || node.type !== "Identifier") {
    return false;
  }
  if (typeof node.name !== "string") {
    return false;
  }
  return name === undefined || node.name === name;
};
export const isStringLiteral = (node) =>
  isAstNode(node) && node.type === "Literal" && typeof node.value === "string";
export const getPropertyName = (node) => {
  if (isIdentifier(node)) {
    return node.name;
  }
  if (isStringLiteral(node)) {
    return node.value;
  }
  return null;
};
export const isMemberAccess = (node, object, property) =>
  isAstNode(node) &&
  node.type === "MemberExpression" &&
  node.computed === false &&
  isIdentifier(node.object, object) &&
  isIdentifier(node.property, property);
export const isCallTo = (node, name) =>
  isAstNode(node) &&
  node.type === "CallExpression" &&
  isIdentifier(node.callee, name);
export const unwrapExpression = (node) => {
  if (!isAstNode(node)) {
    return null;
  }
  if (
    node.type === "TSAsExpression" ||
    node.type === "TSSatisfiesExpression" ||
    node.type === "ChainExpression"
  ) {
    return unwrapExpression(node.expression);
  }
  return node;
};
export const getImportedName = (specifier) => {
  if (!isAstNode(specifier) || specifier.type !== "ImportSpecifier") {
    return null;
  }
  const imported = specifier.imported;
  if (isIdentifier(imported)) {
    return imported.name;
  }
  if (isStringLiteral(imported)) {
    return imported.value;
  }
  return null;
};
