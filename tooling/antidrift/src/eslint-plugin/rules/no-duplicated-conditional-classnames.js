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
]);

function unwrapExpression(node) {
  let current = node;
  while (
    current?.type === "ChainExpression" ||
    current?.type === "TSNonNullExpression" ||
    current?.type === "TSAsExpression" ||
    current?.type === "TSSatisfiesExpression"
  ) {
    current = current.expression;
  }
  return current;
}

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

function classTokens(value) {
  return value
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
}

function uniqueTokens(tokens) {
  return [...new Set(tokens)];
}

function staticPropertyName(member) {
  if (member?.type !== "MemberExpression") return "";
  const property = member.property;
  if (!member.computed && property?.type === "Identifier") return property.name;
  if (property?.type === "Literal" && typeof property.value === "string") {
    return property.value;
  }
  return "";
}

function calleeName(callee) {
  if (callee?.type === "Identifier") return callee.name;
  return staticPropertyName(callee);
}

function jsxAttributeName(node) {
  if (!node) return "";
  if (node.type === "JSXIdentifier") return node.name;
  if (node.type === "JSXNamespacedName") return node.name?.name ?? "";
  return "";
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function invalidOptions(message) {
  throw new TypeError(
    `antidrift/no-duplicated-conditional-classnames options: ${message}`,
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
  const value = requireOption(options, key);
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    invalidOptions(`'${key}' must be an array of non-empty strings.`);
  }
  const unique = new Set(value);
  if (unique.size !== value.length) {
    invalidOptions(`'${key}' must not contain duplicate entries.`);
  }
  return [...unique];
}

function boundedNumber(options, key, predicate, description) {
  const value = requireOption(options, key);
  if (typeof value !== "number" || !Number.isFinite(value) || !predicate(value)) {
    invalidOptions(`'${key}' must be ${description}.`);
  }
  return value;
}

function normalizeOptionShape(options) {
  requireKnownKeys(options);
  return {
    attributeNames: new Set(uniqueStringList(options, "attributes")),
    helperNames: new Set(uniqueStringList(options, "helpers")),
    minSharedRatio: boundedNumber(
      options,
      "minSharedRatio",
      (value) => value >= 0 && value <= 1,
      "between 0 and 1",
    ),
    minSharedTokens: boundedNumber(
      options,
      "minSharedTokens",
      (value) => Number.isInteger(value) && value >= 1,
      "an integer greater than or equal to 1",
    ),
  };
}

function normalizedOptions(rawOptions) {
  if (rawOptions === undefined) return normalizeOptionShape(defaultOptions);
  if (!isRecord(rawOptions)) invalidOptions("must be an object.");
  return normalizeOptionShape(rawOptions);
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

function isClassHelperArgument(node, options) {
  const parent = node.parent;
  if (parent?.type !== "CallExpression") return false;
  return (
    parent.arguments.includes(node) && options.helperNames.has(calleeName(parent.callee))
  );
}

function isClassStringContext(node, options) {
  return (
    isWithinClassAttributeExpression(node, options) ||
    isClassHelperArgument(node, options)
  );
}

function overlapEvidence(leftValue, rightValue, options) {
  const leftTokens = uniqueTokens(classTokens(leftValue));
  const rightTokens = uniqueTokens(classTokens(rightValue));
  if (leftTokens.length === 0 || rightTokens.length === 0) return null;

  const rightSet = new Set(rightTokens);
  const shared = leftTokens.filter((token) => rightSet.has(token));
  const uniqueCount = Math.max(leftTokens.length, rightTokens.length) - shared.length;
  if (uniqueCount === 0) return null;
  if (shared.length < options.minSharedTokens) return null;

  const sharedRatio = shared.length / Math.min(leftTokens.length, rightTokens.length);
  if (sharedRatio < options.minSharedRatio) return null;

  return {
    count: String(shared.length),
    shared: shared.slice(0, 8).join(" "),
  };
}

export default function ruleNoDuplicatedConditionalClassnames() {
  return {
    meta: {
      type: "suggestion",
      docs: {
        description:
          "Disallow conditional class strings that duplicate the same base class list in both branches",
      },
      schema: [
        {
          type: "object",
          additionalProperties: false,
          required: [
            "attributes",
            "helpers",
            "minSharedRatio",
            "minSharedTokens",
          ],
          properties: {
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
      ],
      messages: {
        duplicatedConditionalClassnames:
          "Conditional class strings share {{count}} class tokens ({{shared}}). Hoist the shared class list and keep only the differing tokens conditional.",
      },
    },
    create(context) {
      const options = normalizedOptions(context.options?.[0]);
      return {
        ConditionalExpression(node) {
          if (!isClassStringContext(node, options)) return;

          const leftValue = staticString(node.consequent);
          const rightValue = staticString(node.alternate);
          if (leftValue == null || rightValue == null) return;

          const evidence = overlapEvidence(leftValue, rightValue, options);
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
