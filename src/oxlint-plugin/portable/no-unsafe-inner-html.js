import { importedOwner, importedOwnerSchema } from "./imported-owner.js";
import { isRuleFile, scopeProperties } from "../shared/rule-scope.js";
import { findVariable, unwrapExpression } from "../shared/scope.js";
import { getPropertyName, isIdentifier } from "./ast.js";

const isJsxIdentifier = (node, name) =>
  typeof node === "object" &&
  node !== null &&
  node.type === "JSXIdentifier" &&
  node.name === name;
const isStaticHtml = (node) => {
  if (!node || typeof node.type !== "string") {
    return false;
  }
  if (node.type === "Literal" && typeof node.value === "string") {
    return true;
  }
  if (node.type === "TemplateLiteral") {
    return (
      Array.isArray(node.expressions) && node.expressions.every(isStaticHtml)
    );
  }
  return false;
};
const isInnerHtmlProperty = (property) => {
  if (getPropertyName(property.key) !== "__html") {
    return false;
  }
  const objectExpression = property.parent;
  if (objectExpression?.type !== "ObjectExpression") {
    return false;
  }
  let current = objectExpression.parent;
  while (
    current?.type === "TSAsExpression" ||
    current?.type === "TSSatisfiesExpression"
  ) {
    current = current.parent;
  }
  if (current?.type !== "JSXExpressionContainer") {
    return false;
  }
  const attribute = current.parent;
  return (
    attribute?.type === "JSXAttribute" &&
    isJsxIdentifier(attribute.name, "dangerouslySetInnerHTML")
  );
};
class HtmlProvenance {
  constructor(context) {
    this.context = context;
    this.options = this.context.options[0] ?? {};
    this.sanitizers = this.options.sanitizers ?? [
      { module: "dompurify", export: "default", member: "sanitize" },
    ];
    this.trusted = this.options.trustedSources ?? [];
  }
  proven = (node, seen = new Set()) => {
    node = unwrapExpression(node);
    if (isStaticHtml(node) || importedOwner(this.context, node, this.trusted)) {
      return true;
    }
    if (node?.type === "CallExpression") {
      return importedOwner(this.context, node.callee, this.sanitizers);
    }
    const binding = findVariable(this.context.sourceCode, node);
    if (!binding || seen.has(binding)) return false;
    seen.add(binding);
    const definition = binding.defs[0];
    return (
      definition?.type === "Variable" &&
      definition.parent.kind === "const" &&
      !binding.references.some(
        (reference) => reference.isWrite() && !reference.init
      ) &&
      this.proven(definition.node.init, seen)
    );
  };

  reportIfUnsafe = (node) => {
    if (this.proven(node)) {
      return;
    }
    this.context.report({ node, messageId: "unsafeInnerHtml" });
  };

  reportPayloadSpreads = (objectNode) => {
    for (const property of objectNode.properties) {
      if (property?.type !== "SpreadElement") {
        continue;
      }
      this.context.report({
        node: property,
        messageId: "unsafeInnerHtmlSpread",
      });
    }
  };

  visitJSXAttribute = (node) => {
    if (!isJsxIdentifier(node.name, "dangerouslySetInnerHTML")) {
      return;
    }
    const attributeInitializer = node.value;
    if (attributeInitializer?.type !== "JSXExpressionContainer") {
      return;
    }
    const expression = unwrapExpression(attributeInitializer.expression);
    if (expression?.type === "ObjectExpression") {
      this.reportPayloadSpreads(expression);
      return;
    }
    this.reportIfUnsafe(attributeInitializer.expression);
  };

  visitProperty = (node) => {
    if (!isInnerHtmlProperty(node)) {
      return;
    }
    this.reportIfUnsafe(node.value);
  };

  visitAssignmentExpression = (node) => {
    const target = node.left;
    if (
      target.type !== "MemberExpression" ||
      target.computed ||
      !isIdentifier(target.property, "innerHTML")
    ) {
      return;
    }
    this.reportIfUnsafe(node.right);
  };
  listeners() {
    return {
      JSXAttribute: this.visitJSXAttribute,
      Property: this.visitProperty,
      AssignmentExpression: this.visitAssignmentExpression,
    };
  }
}

export default {
  meta: {
    schema: [
      {
        type: "object",
        properties: {
          ...scopeProperties,
          sanitizers: importedOwnerSchema,
          trustedSources: importedOwnerSchema,
        },
        additionalProperties: false,
      },
    ],

    type: "problem",
    messages: {
      unsafeInnerHtml:
        "Use an imported HTML sanitizer registered in sanitizers, or a trusted imported value registered in trustedSources. The DOM owner requires verifiable provenance for dynamic HTML.",
      unsafeInnerHtmlSpread:
        "Do not spread an object into dangerouslySetInnerHTML. Keep " +
        "`__html` inline so this rule can prove the HTML value is " +
        "sanitized or escaped.",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    return new HtmlProvenance(context).listeners();
  },
};
