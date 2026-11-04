import { classValueVisitors } from "./class-value.js";
import { isRuleFile, scopeProperties } from "../shared/rule-scope.js";

const PHYSICAL_REPLACEMENTS = [
  (classNames) =>
    classNames.replaceAll(
      /(^|[\s"'`{(])(-?)((?:[\w[\]:]*:)?)ml-/gu,
      "$1$2$3ms-"
    ),
  (classNames) =>
    classNames.replaceAll(
      /(^|[\s"'`{(])(-?)((?:[\w[\]:]*:)?)mr-/gu,
      "$1$2$3me-"
    ),
  (classNames) =>
    classNames.replaceAll(
      /(^|[\s"'`{(])(-?)((?:[\w[\]:]*:)?)pl-/gu,
      "$1$2$3ps-"
    ),
  (classNames) =>
    classNames.replaceAll(
      /(^|[\s"'`{(])(-?)((?:[\w[\]:]*:)?)pr-/gu,
      "$1$2$3pe-"
    ),
  (classNames) =>
    classNames.replaceAll(
      /(^|[\s"'`{(])((?:[\w[\]:]*:)?)text-left(?=["'\s`})]|$)/gu,
      "$1$2text-start"
    ),
  (classNames) =>
    classNames.replaceAll(
      /(^|[\s"'`{(])((?:[\w[\]:]*:)?)text-right(?=["'\s`})]|$)/gu,
      "$1$2text-end"
    ),
  (classNames) =>
    classNames.replaceAll(
      /(^|[\s"'`{(])((?:[\w[\]:]*:)?)border-l(?=[-\s"'`})]|$)/gu,
      "$1$2border-s"
    ),
  (classNames) =>
    classNames.replaceAll(
      /(^|[\s"'`{(])((?:[\w[\]:]*:)?)border-r(?=[-\s"'`})]|$)/gu,
      "$1$2border-e"
    ),
  (classNames) =>
    classNames.replaceAll(
      /(^|[\s"'`{(])((?:[\w[\]:]*:)?)rounded-tl(?=[-\s"'`})]|$)/gu,
      "$1$2rounded-ss"
    ),
  (classNames) =>
    classNames.replaceAll(
      /(^|[\s"'`{(])((?:[\w[\]:]*:)?)rounded-tr(?=[-\s"'`})]|$)/gu,
      "$1$2rounded-se"
    ),
  (classNames) =>
    classNames.replaceAll(
      /(^|[\s"'`{(])((?:[\w[\]:]*:)?)rounded-bl(?=[-\s"'`})]|$)/gu,
      "$1$2rounded-es"
    ),
  (classNames) =>
    classNames.replaceAll(
      /(^|[\s"'`{(])((?:[\w[\]:]*:)?)rounded-br(?=[-\s"'`})]|$)/gu,
      "$1$2rounded-ee"
    ),
  (classNames) =>
    classNames.replaceAll(
      /(^|[\s"'`{(])((?:[\w[\]:]*:)?)rounded-l(?=[-\s"'`})]|$)/gu,
      "$1$2rounded-s"
    ),
  (classNames) =>
    classNames.replaceAll(
      /(^|[\s"'`{(])((?:[\w[\]:]*:)?)rounded-r(?=[-\s"'`})]|$)/gu,
      "$1$2rounded-e"
    ),
  (classNames) =>
    classNames.replaceAll(
      /(^|[\s"'`{(])(-?)((?:[\w[\]:]*:)?)left-/gu,
      "$1$2$3start-"
    ),
  (classNames) =>
    classNames.replaceAll(
      /(^|[\s"'`{(])(-?)((?:[\w[\]:]*:)?)right-/gu,
      "$1$2$3end-"
    ),
  (classNames) =>
    classNames.replaceAll(
      /(^|[\s"'`{(])((?:[\w[\]:]*:)?)scroll-ml-/gu,
      "$1$2scroll-ms-"
    ),
  (classNames) =>
    classNames.replaceAll(
      /(^|[\s"'`{(])((?:[\w[\]:]*:)?)scroll-mr-/gu,
      "$1$2scroll-me-"
    ),
  (classNames) =>
    classNames.replaceAll(
      /(^|[\s"'`{(])((?:[\w[\]:]*:)?)scroll-pl-/gu,
      "$1$2scroll-ps-"
    ),
  (classNames) =>
    classNames.replaceAll(
      /(^|[\s"'`{(])((?:[\w[\]:]*:)?)scroll-pr-/gu,
      "$1$2scroll-pe-"
    ),
];

const replaceOutsideArbitraryBrackets = (classNames, replace) => {
  let replacedSegments = "";
  let segmentStart = 0;
  let bracketStart = 0;
  let depth = 0;
  let escaped = false;
  let quote = null;
  for (let index = 0; index < classNames.length; index += 1) {
    const character = classNames[index];
    if (character === "\\" && !escaped) {
      escaped = true;
      continue;
    }
    if (depth > 0 && quote !== null) {
      if (!escaped && character === quote) {
        quote = null;
      }
      escaped = false;
      continue;
    }
    if (
      !escaped &&
      depth > 0 &&
      (character === '"' || character === "'" || character === "`")
    ) {
      quote = character;
      continue;
    }
    if (!escaped && character === "[") {
      if (depth === 0) {
        replacedSegments += replace(classNames.slice(segmentStart, index));
        bracketStart = index;
      }
      depth += 1;
    } else if (!escaped && character === "]" && depth > 0) {
      depth -= 1;
      if (depth === 0) {
        replacedSegments += classNames.slice(bracketStart, index + 1);
        segmentStart = index + 1;
      }
    }
    escaped = false;
  }
  if (depth > 0) {
    return replacedSegments + classNames.slice(bracketStart);
  }
  return replacedSegments + replace(classNames.slice(segmentStart));
};

const replacePhysicalProperties = (classNames) => {
  let replaced = classNames;
  for (const replace of PHYSICAL_REPLACEMENTS) {
    replaced = replaceOutsideArbitraryBrackets(replaced, replace);
  }
  return replaced;
};

const hasPhysicalProperty = (classNames) =>
  PHYSICAL_REPLACEMENTS.some((replace) => replace(classNames) !== classNames);

const isClassNameAttribute = (node) =>
  node?.type === "JSXAttribute" &&
  node.name.type === "JSXIdentifier" &&
  node.name.name === "className";
const isDirectClassName = (node) => {
  if (isClassNameAttribute(node.parent) && node.parent.value === node) {
    return true;
  }
  if (
    node.parent?.type === "JSXExpressionContainer" &&
    node.parent.expression === node &&
    isClassNameAttribute(node.parent.parent)
  ) {
    return true;
  }
  if (node.type !== "TemplateElement") {
    return false;
  }
  const template = node.parent;
  const container = template?.parent;
  return (
    template?.type === "TemplateLiteral" &&
    template.quasis.at(0) === node &&
    container?.type === "JSXExpressionContainer" &&
    container.expression === template &&
    isClassNameAttribute(container.parent)
  );
};
function withoutSymmetricInsets(classNames) {
  return classNames.replaceAll(
    /\b(left|right)-([\w.]+)\b/gu,
    (token, side, size) => {
      const other = side === "left" ? "right" : "left";
      return classNames.split(/\s+/u).includes(`${other}-${size}`) ? "" : token;
    }
  );
}
const reportPhysicalProperty = (context, node) => {
  if (!isDirectClassName(node)) {
    context.report({ node, messageId: "physicalProperty" });
    return;
  }
  context.report({
    node,
    messageId: "physicalProperty",
    fix: (fixer) => {
      const source = context.sourceCode.getText(node);
      if (
        source.includes("\\") ||
        /&(?:#(?:x[\da-f]+|\d+)|[a-z][\da-z]+);/iu.test(source)
      ) {
        return null;
      }
      const replacement = replacePhysicalProperties(source);
      return replacement === source
        ? null
        : fixer.replaceText(node, replacement);
    },
  });
};
export default {
  meta: {
    schema: [
      {
        type: "object",
        properties: scopeProperties,
        additionalProperties: false,
      },
    ],

    type: "problem",
    fixable: "code",
    messages: {
      physicalProperty:
        "Physical directional CSS property breaks RTL. " +
        "Use logical equivalents: " +
        "ml→ms, mr→me, pl→ps, pr→pe, " +
        "left→start, right→end, " +
        "text-left→text-start, text-right→text-end, " +
        "border-l→border-s, border-r→border-e, " +
        "rounded-l→rounded-s, rounded-r→rounded-e.",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};

    return classValueVisitors(context, (node, classNames) => {
      if (hasPhysicalProperty(withoutSymmetricInsets(classNames))) {
        reportPhysicalProperty(context, node);
      }
    });
  },
};
