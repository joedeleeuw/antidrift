import { isRuleFile, scopeProperties } from "./scope.js";

const NAME_PROPS = new Set([
  "displayName",
  "fullName",
  "firstName",
  "lastName",
  "clientName",
  "contactName",
  "organizationName",
  "partyName",
  "authorName",
  "workspaceName",
  "matterName",
  "entityName",
  "fileName",
  "folderName",
  "email",
  "caseNumber",
  "citationText",
]);
const SELF_ISOLATING = new Set(["BidiText", "UserText"]);
const RAW_ISOLATING = new Set(["bdi", "bdo"]);
const hasDirAttr = (opening) =>
  opening.attributes.some(
    (attr) =>
      attr.type === "JSXAttribute" &&
      attr.name?.type === "JSXIdentifier" &&
      attr.name.name === "dir",
  );
const meaningfulChildren = (children) =>
  children.filter(
    (child) => !(child.type === "JSXText" && child.value.trim().length === 0),
  );
const isNameExpr = (expr, nameProps) =>
  (expr.type === "MemberExpression" ||
    expr.type === "OptionalMemberExpression") &&
  expr.property.type === "Identifier" &&
  nameProps.has(expr.property.name);
export default {
  meta: {
    schema: [
      {
        type: "object",
        properties: {
          ...scopeProperties,
          nameProps: { type: "array", items: { type: "string" } },
          isolatingComponents: { type: "array", items: { type: "string" } },
          owner: { type: "string", minLength: 1 },
        },
        additionalProperties: false,
      },
    ],

    type: "problem",
    messages: {
      missingDir:
        "Isolate external names with {{owner}} so bidirectional text cannot reorder surrounding content.",
      missingBidi:
        "Isolate this external name with {{owner}}; setting direction on the parent would also reorder its siblings.",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    const options = context.options[0] ?? {};
    const names = new Set(options.nameProps ?? NAME_PROPS);
    const components = new Set(options.isolatingComponents ?? SELF_ISOLATING);
    const data = {
      owner:
        options.owner ??
        "Unicode FSI (\\u2068) and PDI (\\u2069), or an HTML bdi element",
    };

    return {
      JSXElement(node) {
        const opening = node.openingElement;
        const elementName =
          opening.name.type === "JSXIdentifier" ? opening.name.name : null;
        if (elementName !== null && components.has(elementName)) {
          return;
        }
        const kids = meaningfulChildren(node.children);
        const nameKids = kids.filter(
          (child) =>
            child.type === "JSXExpressionContainer" &&
            isNameExpr(child.expression, names),
        );
        if (nameKids.length === 0) {
          return;
        }
        if (kids.length === 1) {
          if (
            hasDirAttr(opening) ||
            (elementName !== null && RAW_ISOLATING.has(elementName))
          ) {
            return;
          }
          if (!hasDirAttr(opening)) {
            context.report({ node: opening, messageId: "missingDir", data });
          }
          return;
        }
        for (const child of nameKids) {
          context.report({ node: child, messageId: "missingBidi", data });
        }
      },
    };
  },
};
