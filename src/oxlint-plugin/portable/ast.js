export const filenameForContext = (context) =>
  (context.filename ?? "").replaceAll("\\", "/");
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
export const staticTemplateText = (node) => {
  if (
    !isAstNode(node) ||
    node.type !== "TemplateLiteral" ||
    !Array.isArray(node.expressions) ||
    node.expressions.length !== 0 ||
    !Array.isArray(node.quasis) ||
    node.quasis.length !== 1
  ) {
    return null;
  }
  const quasi = node.quasis.at(0);
  if (
    !isAstNode(quasi) ||
    quasi.type !== "TemplateElement" ||
    typeof quasi.value !== "object" ||
    quasi.value === null ||
    !("cooked" in quasi.value)
  ) {
    return null;
  }
  return typeof quasi.value.cooked === "string" ? quasi.value.cooked : null;
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
const SKIPPED_CHILD_KEYS = new Set(["parent", "range", "loc"]);
export const findDescendant = (root, predicate, descendInto = () => true) => {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== "object") {
      continue;
    }
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    if (!descendInto(current)) {
      continue;
    }
    if (predicate(current)) {
      return current;
    }
    for (const [key, child] of Object.entries(current)) {
      if (!SKIPPED_CHILD_KEYS.has(key) && child && typeof child === "object") {
        pending.push(child);
      }
    }
  }
  return null;
};
export const jsxElementName = (node) => {
  if (!isAstNode(node)) {
    return null;
  }
  if (node.type === "JSXIdentifier" && typeof node.name === "string") {
    return node.name;
  }
  if (node.type === "JSXMemberExpression") {
    return jsxElementName(node.property);
  }
  if (node.type === "JSXNamespacedName") {
    return jsxElementName(node.name);
  }
  return null;
};
export const jsxOpeningElement = (element) => {
  if (!isAstNode(element) || element.type !== "JSXElement") {
    return null;
  }
  return isAstNode(element.openingElement) ? element.openingElement : null;
};
export const nameOfJsxElement = (element) =>
  jsxElementName(jsxOpeningElement(element)?.name);
export const jsxAttributeName = (attribute) =>
  isAstNode(attribute) && attribute.type === "JSXAttribute"
    ? jsxElementName(attribute.name)
    : null;
export const jsxAttributes = (openingElement) =>
  isAstNode(openingElement) && Array.isArray(openingElement.attributes)
    ? openingElement.attributes
    : [];
export const jsxAttribute = (openingElement, name) =>
  jsxAttributes(openingElement).find(
    (attribute) => jsxAttributeName(attribute) === name
  ) ?? null;
export const jsxRenderElement = (openingElement) => {
  const attributeInitializer = jsxAttribute(openingElement, "render")?.value;
  if (!isAstNode(attributeInitializer)) {
    return null;
  }
  const expression =
    attributeInitializer.type === "JSXExpressionContainer"
      ? attributeInitializer.expression
      : attributeInitializer;
  return isAstNode(expression) && expression.type === "JSXElement"
    ? expression
    : null;
};
export const jsxChildElements = (element) =>
  isAstNode(element) && Array.isArray(element.children)
    ? element.children.filter(
        (child) => isAstNode(child) && child.type === "JSXElement"
      )
    : [];
