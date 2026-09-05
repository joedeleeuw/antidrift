import { isRuleFile, scopeProperties } from "./scope.js";
import { filenameForContext, isAstNode, isStringLiteral } from "./ast.js";

const LOADER_ICON_NAMES = [
  "LoaderIcon",
  "Loader2Icon",
  "LoaderCircleIcon",
  "LoaderPinwheelIcon",
];
const BANNED_UTILITY = /(?:^|\s)animate-(?:spin|pulse)(?:\s|$)/u;
const isAllowedFile = (context, allowedFiles) => {
  const filename = filenameForContext(context);
  return allowedFiles.some((allowedFile) => {
    if (typeof allowedFile === "string") {
      return filename.endsWith(allowedFile);
    }
    return (
      typeof allowedFile === "object" &&
      allowedFile !== null &&
      "path" in allowedFile &&
      typeof allowedFile.path === "string" &&
      filename.endsWith(allowedFile.path)
    );
  });
};
const jsxElementName = (node) => {
  if (!isAstNode(node)) {
    return null;
  }
  if (node.type === "JSXIdentifier" && typeof node.name === "string") {
    return node.name;
  }
  if (node.type === "JSXMemberExpression") {
    return jsxElementName(node.property);
  }
  return null;
};
const jsxAttributeName = (node) =>
  isAstNode(node) &&
  isAstNode(node.name) &&
  node.name.type === "JSXIdentifier" &&
  typeof node.name.name === "string"
    ? node.name.name
    : null;
const staticStrings = (node, out) => {
  if (!isAstNode(node)) {
    return;
  }
  if (isStringLiteral(node)) {
    out.push(node.value);
    return;
  }
  if (node.type === "TemplateLiteral" && Array.isArray(node.quasis)) {
    for (const quasi of node.quasis) {
      const value = isAstNode(quasi) ? quasi.value : undefined;
      const cooked =
        typeof value === "object" && value !== null && "cooked" in value
          ? value.cooked
          : undefined;
      if (typeof cooked === "string") {
        out.push(cooked);
      }
    }
    return;
  }
  if (node.type === "JSXExpressionContainer") {
    staticStrings(node.expression, out);
    return;
  }
  if (node.type === "CallExpression" && Array.isArray(node.arguments)) {
    for (const argument of node.arguments) {
      staticStrings(argument, out);
    }
    return;
  }
  if (
    node.type === "LogicalExpression" ||
    node.type === "ConditionalExpression"
  ) {
    staticStrings(node.consequent ?? node.left, out);
    staticStrings(node.alternate ?? node.right, out);
  }
};
export default {
  meta: {
    type: "problem",
    messages: {
      loaderIcon:
        "Do not render '{{name}}' as a loading indicator. Use {{owner}}.",
      animateUtility:
        "Do not build a loading indicator from 'animate-{{utility}}'. Use {{owner}} or {{skeleton}} for content with a known shape.",
      progressbar:
        "Do not hand-roll a progress bar. Use {{owner}} with accessible progress text.",
    },
    schema: [
      {
        type: "object",
        properties: {
          ...scopeProperties,
          loaderIcons: { type: "array", items: { type: "string" } },
          owner: { type: "string", minLength: 1 },
          skeleton: { type: "string", minLength: 1 },
          allowedFiles: {
            type: "array",
            items: {
              anyOf: [
                { type: "string" },
                {
                  type: "object",
                  properties: {
                    path: { type: "string" },
                    reason: { type: "string" },
                  },
                  required: ["path", "reason"],
                  additionalProperties: false,
                },
              ],
            },
          },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    const options = context.options[0] ?? {};
    const icons = new Set(options.loaderIcons ?? LOADER_ICON_NAMES);
    const owners = {
      owner: options.owner ?? "the HTML progress element",
      skeleton: options.skeleton ?? "accessible placeholder text",
    };

    if (
      (() => {
        const options = context.options.at(0);
        const allowedFiles =
          typeof options === "object" &&
          options !== null &&
          !Array.isArray(options) &&
          Array.isArray(options.allowedFiles)
            ? options.allowedFiles
            : [];
        return !isAllowedFile(context, allowedFiles);
      })() === false
    ) {
      return {};
    }
    return {
      JSXOpeningElement(node) {
        const name = jsxElementName(node.name);
        if (name !== null && icons.has(name)) {
          context.report({
            node,
            messageId: "loaderIcon",
            data: { name, ...owners },
          });
        }
      },
      JSXAttribute(node) {
        const name = jsxAttributeName(node);
        if (name === "role") {
          const parts = [];
          staticStrings(node.value, parts);
          if (parts.includes("progressbar")) {
            context.report({ node, messageId: "progressbar", data: owners });
          }
          return;
        }
        if (name !== "className") {
          return;
        }
        const parts = [];
        staticStrings(node.value, parts);
        for (const part of parts) {
          const match = BANNED_UTILITY.exec(part);
          if (match !== null) {
            const utility = match[0].trim().slice("animate-".length);
            context.report({
              node,
              messageId: "animateUtility",
              data: { utility, ...owners },
            });
            return;
          }
        }
      },
    };
  },
};
