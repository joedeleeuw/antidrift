import { isRuleFile, scopeProperties } from "../shared/rule-scope.js";
import { calleeName, unwrapExpression } from "../shared/scope.js";

const defaultAttributes = ["class", "className"];
const defaultHelpers = [];
const defaultOptions = {
  attributes: defaultAttributes,
  helpers: defaultHelpers,
  minSharedRatio: 0.65,
  minSharedTokens: 4,
};
const optionKeys = new Set([
  "attributes",
  "helpers",
  "minSharedRatio",
  "minSharedTokens",
  "files",
  "excludeFiles",
]);

function staticString(node) {
  const expression = unwrapExpression(node);
  if (expression?.type === "Literal" && typeof expression.value === "string") {
    return expression.value;
  }
  if (
    expression?.type === "TemplateLiteral" &&
    expression.expressions.length === 0
  ) {
    return expression.quasis.map((quasi) => quasi.value.cooked ?? "").join("");
  }
  return null;
}

function classTokens(classText) {
  return classText.trim().split(/\s+/u).filter(Boolean);
}

function uniqueTokens(tokens) {
  return [...new Set(tokens)];
}

function jsxAttributeName(node) {
  if (!node) return "";
  if (node.type === "JSXIdentifier") return node.name;
  if (node.type === "JSXNamespacedName") return node.name?.name ?? "";
  return "";
}

function isRecord(candidate) {
  return (
    Boolean(candidate) &&
    typeof candidate === "object" &&
    !Array.isArray(candidate)
  );
}

function invalidOptions(message) {
  throw new TypeError(
    `antidrift/no-duplicated-conditional-classnames options: ${message}`
  );
}

function requireKnownKeys(options) {
  for (const key of Object.keys(options)) {
    if (!optionKeys.has(key)) invalidOptions(`unknown option '${key}'.`);
  }
}

function requireOption(options, key) {
  if (!Object.hasOwn(options, key)) invalidOptions(`missing '${key}'.`);
  return options[key];
}

function uniqueStringList(options, key) {
  const entries = requireOption(options, key);
  if (
    !Array.isArray(entries) ||
    entries.some((entry) => typeof entry !== "string" || entry.length === 0)
  ) {
    invalidOptions(`'${key}' must be an array of non-empty strings.`);
  }
  const unique = new Set(entries);
  if (unique.size !== entries.length) {
    invalidOptions(`'${key}' must not contain duplicate entries.`);
  }
  return [...unique];
}

function boundedNumber(rawNumber, key, predicate, description) {
  if (
    typeof rawNumber !== "number" ||
    !Number.isFinite(rawNumber) ||
    !predicate(rawNumber)
  ) {
    invalidOptions(`'${key}' must be ${description}.`);
  }
  return rawNumber;
}

function normalizeOptionShape(options) {
  requireKnownKeys(options);
  return {
    attributeNames: new Set(uniqueStringList(options, "attributes")),
    helperNames: new Set(uniqueStringList(options, "helpers")),
    minSharedRatio: boundedNumber(
      requireOption(options, "minSharedRatio"),
      "minSharedRatio",
      (ratio) => ratio >= 0 && ratio <= 1,
      "between 0 and 1"
    ),
    minSharedTokens: boundedNumber(
      requireOption(options, "minSharedTokens"),
      "minSharedTokens",
      (tokenCount) => Number.isInteger(tokenCount) && tokenCount >= 1,
      "an integer greater than or equal to 1"
    ),
  };
}

function normalizedOptions(rawOptions) {
  if (rawOptions === undefined) return normalizeOptionShape(defaultOptions);
  if (!isRecord(rawOptions)) invalidOptions("must be an object.");
  requireKnownKeys(rawOptions);
  return normalizeOptionShape({ ...defaultOptions, ...rawOptions });
}

function isFunctionBoundary(node) {
  return (
    node?.type === "FunctionDeclaration" ||
    node?.type === "FunctionExpression" ||
    node?.type === "ArrowFunctionExpression"
  );
}

function isWithinClassAttributeExpression(node, options) {
  let current = node.parent;
  while (current) {
    if (
      current.type === "JSXExpressionContainer" &&
      current.parent?.type === "JSXAttribute" &&
      options.attributeNames.has(jsxAttributeName(current.parent.name))
    ) {
      return true;
    }
    if (isFunctionBoundary(current)) return false;
    current = current.parent;
  }
  return false;
}

function classValueWrapperParent(node) {
  const parent = node.parent;
  if (parent?.type === "ArrayExpression") return parent;
  if (parent?.type === "SpreadElement") return parent;
  if (
    parent?.type === "Property" &&
    (parent.value === node || (parent.computed && parent.key === node)) &&
    parent.parent?.type === "ObjectExpression"
  ) {
    return parent.parent;
  }
  return null;
}

function isClassHelperArgument(node, options) {
  let current = node;
  let wrapper = classValueWrapperParent(current);
  while (wrapper) {
    current = wrapper;
    wrapper = classValueWrapperParent(current);
  }
  const parent = current.parent;
  if (parent?.type !== "CallExpression") return false;
  return (
    parent.arguments.includes(current) &&
    options.helperNames.has(calleeName(parent))
  );
}

function isClassStringContext(node, options) {
  return (
    isWithinClassAttributeExpression(node, options) ||
    isClassHelperArgument(node, options)
  );
}

function overlapEvidence(consequentClass, alternateClass, options) {
  const leftTokens = uniqueTokens(classTokens(consequentClass));
  const rightTokens = uniqueTokens(classTokens(alternateClass));
  if (leftTokens.length === 0 || rightTokens.length === 0) return null;

  const rightSet = new Set(rightTokens);
  const shared = leftTokens.filter((token) => rightSet.has(token));
  const uniqueCount =
    Math.max(leftTokens.length, rightTokens.length) - shared.length;
  if (uniqueCount === 0) return null;
  if (shared.length < options.minSharedTokens) return null;

  const sharedRatio =
    shared.length / Math.min(leftTokens.length, rightTokens.length);
  if (sharedRatio < options.minSharedRatio) return null;

  return {
    count: String(shared.length),
    shared: shared.slice(0, 8).join(" "),
  };
}

const ruleSchema = [
  {
    type: "object",
    additionalProperties: false,
    properties: {
      ...scopeProperties,
      attributes: {
        type: "array",
        items: { type: "string", minLength: 1 },
        uniqueItems: true,
      },
      helpers: {
        type: "array",
        items: { type: "string", minLength: 1 },
        uniqueItems: true,
      },
      minSharedRatio: {
        type: "number",
        minimum: 0,
        maximum: 1,
      },
      minSharedTokens: {
        type: "integer",
        minimum: 1,
      },
    },
  },
];

export default function ruleNoDuplicatedConditionalClassnames() {
  return {
    meta: {
      type: "suggestion",
      docs: {
        description:
          "Disallow conditional class strings that duplicate the same base class list in both branches",
      },
      schema: ruleSchema,
      messages: {
        duplicatedConditionalClassnames:
          "Conditional class strings share {{count}} class tokens ({{shared}}). Hoist the shared class list and keep only the differing tokens conditional.",
      },
    },
    create(context) {
      if (!isRuleFile(context)) return {};
      const options = normalizedOptions(context.options?.[0]);
      return {
        ConditionalExpression(node) {
          if (!isClassStringContext(node, options)) return;
          const consequentClass = staticString(node.consequent);
          const alternateClass = staticString(node.alternate);
          if (consequentClass === null || alternateClass === null) return;
          const evidence = overlapEvidence(
            consequentClass,
            alternateClass,
            options
          );
          if (!evidence) return;
          context.report({
            node,
            messageId: "duplicatedConditionalClassnames",
            data: evidence,
          });
        },
      };
    },
  };
}
