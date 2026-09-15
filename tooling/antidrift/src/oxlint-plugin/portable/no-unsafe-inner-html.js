import {
  importedOwner,
  importedOwnerSchema,
  findVariable,
} from "./imported-owner.js";
import { isRuleFile, scopeProperties } from "./scope.js";
import { getPropertyName, isIdentifier, unwrapExpression } from "./ast.js";

const isJsxIdentifier = (node, name) =>
  typeof node === "object" &&
  node !== null &&
  node.type === "JSXIdentifier" &&
  node.name === name;
const isProvenSafeValue = (node) => {
  if (!node || typeof node.type !== "string") {
    return false;
  }
  if (node.type === "Literal" && typeof node.value === "string") {
    return true;
  }
  if (node.type === "TemplateLiteral") {
    return (
      Array.isArray(node.expressions) &&
      node.expressions.every(isProvenSafeValue)
    );
  }
  return false;
};
const isDangerouslySetInnerHtmlValue = (property) => {
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

    const options = context.options[0] ?? {};
    const sanitizers = options.sanitizers ?? [
      { module: "dompurify", export: "default", member: "sanitize" },
    ];
    const trusted = options.trustedSources ?? [];
    function proven(node, seen = new Set()) {
      node = unwrapExpression(node);
      if (isProvenSafeValue(node) || importedOwner(context, node, trusted)) {
        return true;
      }
      if (node?.type === "CallExpression") {
        return importedOwner(context, node.callee, sanitizers);
      }
      const variable = findVariable(context, node);
      if (!variable || seen.has(variable)) return false;
      seen.add(variable);
      const definition = variable.defs[0];
      return (
        definition?.type === "Variable" &&
        definition.parent.kind === "const" &&
        !variable.references.some(
          (reference) => reference.isWrite() && !reference.init,
        ) &&
        proven(definition.node.init, seen)
      );
    }
    const reportIfUnsafe = (node) => {
      if (proven(node)) {
        return;
      }
      context.report({ node, messageId: "unsafeInnerHtml" });
    };
    const reportPayloadSpreads = (objectNode) => {
      for (const property of objectNode.properties) {
        if (property?.type !== "SpreadElement") {
          continue;
        }
        context.report({
          node: property,
          messageId: "unsafeInnerHtmlSpread",
        });
      }
    };
    return {
      JSXAttribute(node) {
        if (!isJsxIdentifier(node.name, "dangerouslySetInnerHTML")) {
          return;
        }
        const value = node.value;
        if (value?.type !== "JSXExpressionContainer") {
          return;
        }
        const expression = unwrapExpression(value.expression);
        if (expression?.type === "ObjectExpression") {
          reportPayloadSpreads(expression);
          return;
        }
        reportIfUnsafe(value.expression);
      },
      Property(node) {
        if (!isDangerouslySetInnerHtmlValue(node)) {
          return;
        }
        reportIfUnsafe(node.value);
      },
      AssignmentExpression(node) {
        const target = node.left;
        if (
          target.type !== "MemberExpression" ||
          target.computed ||
          !isIdentifier(target.property, "innerHTML")
        ) {
          return;
        }
        reportIfUnsafe(node.right);
      },
    };
  },
};
