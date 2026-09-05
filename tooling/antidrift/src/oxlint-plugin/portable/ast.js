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
export const getCalleeName = (callee) => {
  if (isIdentifier(callee)) {
    return callee.name;
  }
  if (!isAstNode(callee) || callee.type !== "MemberExpression") {
    return null;
  }
  if (callee.computed !== false) {
    return null;
  }
  const objectName = getCalleeName(callee.object);
  const propertyName = getPropertyName(callee.property);
  if (propertyName === null) {
    return null;
  }
  return objectName === null ? propertyName : `${objectName}.${propertyName}`;
};
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
export const getImportLocalName = (specifier) => {
  if (!isAstNode(specifier) || specifier.type !== "ImportSpecifier") {
    return null;
  }
  return isIdentifier(specifier.local) ? specifier.local.name : null;
};
const PER_ITERATION_LOOP_FIELDS = {
  ForStatement: ["body", "test", "update"],
  ForOfStatement: ["body"],
  ForInStatement: ["body"],
  WhileStatement: ["body", "test"],
  DoWhileStatement: ["body", "test"],
};
export const LOOP_NODE_TYPES = new Set(Object.keys(PER_ITERATION_LOOP_FIELDS));
export const isPerIterationLoopPosition = (loop, child) => {
  if (!isAstNode(loop)) {
    return false;
  }
  const fields = PER_ITERATION_LOOP_FIELDS[loop.type];
  return fields?.some((field) => loop[field] === child) ?? false;
};
const isResultTryPromiseArgument = (node) => {
  if (!isAstNode(node)) {
    return false;
  }
  const call = node.parent;
  if (
    !isAstNode(call) ||
    call.type !== "CallExpression" ||
    !isMemberAccess(call.callee, "Result", "tryPromise")
  ) {
    return false;
  }
  return Array.isArray(call.arguments) && call.arguments.includes(node);
};
export const isResultTryPromiseCallback = (fnNode) => {
  if (!isAstNode(fnNode)) {
    return false;
  }
  const parent = fnNode.parent;
  if (
    isAstNode(parent) &&
    parent.type === "Property" &&
    parent.value === fnNode &&
    getPropertyName(parent.key) === "try"
  ) {
    const objectExpression = parent.parent;
    return (
      isAstNode(objectExpression) &&
      objectExpression.type === "ObjectExpression" &&
      isResultTryPromiseArgument(objectExpression)
    );
  }
  return isResultTryPromiseArgument(fnNode);
};
export const resolveChainRootName = (node) => {
  const current = unwrapExpression(node);
  if (!isAstNode(current)) {
    return null;
  }
  if (current.type === "CallExpression") {
    return resolveChainRootName(current.callee);
  }
  if (current.type === "MemberExpression") {
    return resolveChainRootName(current.object);
  }
  return isIdentifier(current) ? current.name : null;
};
