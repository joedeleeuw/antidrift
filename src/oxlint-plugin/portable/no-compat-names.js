import { getProgramIndex } from "../shared/program-index.js";
import { isRuleFile, scopeProperties } from "../shared/rule-scope.js";
import {
  findVariable,
  splitIdentifierWords,
  unwrapExpression,
} from "../shared/scope.js";
import { patternIdentifiers } from "./static-resolution.js";

const REMOVAL_VOCABULARY =
  /legacy|compat(?!ib(?:le|ility))|backwards?_?compat|deprecated|no_?longer/i;
const RETIREMENT_VOCABULARY = /retired(?!At\b)/iu;
const COMPATIBILITY_TERM = /compatib(?:le|ility)/iu;
const REMOVAL_ROLE =
  /(?:Shims?|Fallback|Layer)(?=[A-Z_\d]|$)|(?:^|_)(?:shims?|fallback|layer|SHIMS?|FALLBACK|LAYER)(?=_|$)/u;
const AFFIX_STRIP_RE =
  /^(?:legacy|deprecated|(?:backwards?_?)?compat(?:ible|ibility)?|retired|old)_?|(?:\s|_)?(?:Legacy|Deprecated|Compat|Retired|Old|Shims?|Fallback|Layer)$/giu;
const SNAKE_KEY_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/u;
const CAMEL_KEY_PATTERN = /^[a-z][a-zA-Z0-9]*$/u;

function isSnakeCamelAliasPair(leftKey, rightKey) {
  const leftSnake = SNAKE_KEY_PATTERN.test(leftKey);
  const rightSnake = SNAKE_KEY_PATTERN.test(rightKey);
  if (leftSnake === rightSnake) return false;
  const camelCandidate = leftSnake ? rightKey : leftKey;
  if (!CAMEL_KEY_PATTERN.test(camelCandidate)) return false;
  return (
    leftKey.replaceAll("_", "").toLowerCase() ===
    rightKey.replaceAll("_", "").toLowerCase()
  );
}

function memberReadKey(member) {
  if (!member.computed && member.property?.type === "Identifier") {
    return member.property.name;
  }
  if (
    member.computed &&
    member.property?.type === "Literal" &&
    typeof member.property.value === "string"
  ) {
    return member.property.value;
  }
  return null;
}

function patternKeyName(key) {
  if (key?.type === "Identifier") return key.name;
  return key?.type === "Literal" && typeof key.value === "string"
    ? key.value
    : null;
}

function destructuredPropertyIn(pattern, boundName) {
  const target = pattern?.type === "AssignmentPattern" ? pattern.left : pattern;
  if (target?.type !== "ObjectPattern") return null;
  for (const property of target.properties) {
    if (property.type !== "Property" || property.computed) continue;
    const bound =
      property.value?.type === "AssignmentPattern"
        ? property.value.left
        : property.value;
    if (bound?.type === "Identifier" && bound.name === boundName) {
      return { source: target, key: patternKeyName(property.key) };
    }
  }
  return null;
}

function destructuredRead(identifier, sourceCode) {
  const definition = findVariable(sourceCode, identifier)?.defs?.[0];
  let patterns = [];
  if (definition?.node?.type === "VariableDeclarator") {
    patterns = [definition.node.id];
  } else if (definition?.type === "Parameter") {
    patterns = definition.node?.params ?? [];
  }
  for (const pattern of patterns) {
    const found = destructuredPropertyIn(pattern, identifier.name);
    if (found) return found;
  }
  return null;
}

function dualReadSide(expression, sourceCode) {
  const node = unwrapExpression(expression);
  if (node?.type === "MemberExpression") {
    const key = memberReadKey(node);
    return key === null
      ? null
      : {
          key,
          source: sourceCode
            .getText(unwrapExpression(node.object))
            .replaceAll(/\s+/gu, ""),
        };
  }
  return node?.type === "Identifier"
    ? destructuredRead(node, sourceCode)
    : null;
}

function checkDualKeyAliasRead(node, context) {
  if (node.operator !== "??" && node.operator !== "||") return;
  const sourceCode = context.sourceCode;
  const left = dualReadSide(node.left, sourceCode);
  const right = dualReadSide(node.right, sourceCode);
  if (
    !left?.key ||
    !right?.key ||
    left.source !== right.source ||
    !isSnakeCamelAliasPair(left.key, right.key)
  ) {
    return;
  }
  const leftText = sourceCode.getText(node.left).replaceAll(/\s+/gu, " ");
  const rightText = sourceCode.getText(node.right).replaceAll(/\s+/gu, " ");
  context.report({
    node,
    message: `Dual-key read '${leftText} ${node.operator} ${rightText}' probes both snake_case and camelCase spellings on the same receiver; normalize once at the boundary schema and read one canonical property.`,
  });
}

function canonicalReplacementName(name, sourceCode) {
  const index = getProgramIndex(sourceCode);
  if (!index) return null;
  const words = splitIdentifierWords(name).join("\0");
  const stripped = name.replaceAll(AFFIX_STRIP_RE, (affix, offset) => {
    const partitioned = [
      ...splitIdentifierWords(name.slice(0, offset)),
      ...splitIdentifierWords(affix),
      ...splitIdentifierWords(name.slice(offset + affix.length)),
    ];
    return partitioned.join("\0") === words ? "" : affix;
  });
  if (!stripped || stripped === name) return null;
  const camel = stripped.charAt(0).toLowerCase() + stripped.slice(1);
  if (index.declaredNames.has(stripped)) return stripped;
  if (index.declaredNames.has(camel)) return camel;
  return null;
}

function createNameVisitors(context) {
  function check(node) {
    if (
      node?.type === "Identifier" &&
      (REMOVAL_VOCABULARY.test(node.name) ||
        (RETIREMENT_VOCABULARY.test(node.name) &&
          splitIdentifierWords(node.name).some((word) =>
            word.startsWith("retired")
          )) ||
        (COMPATIBILITY_TERM.test(node.name) && REMOVAL_ROLE.test(node.name)))
    ) {
      const canonical = canonicalReplacementName(node.name, context.sourceCode);
      context.report({
        node,
        messageId: canonical ? "compatNameWithCanonical" : "compatName",
        data: canonical ? { name: node.name, canonical } : { name: node.name },
      });
    }
  }
  function checkPattern(pattern) {
    for (const identifier of patternIdentifiers(pattern)) check(identifier);
  }
  function checkFunction(node) {
    if (node.type === "FunctionDeclaration") check(node.id);
    for (const parameter of node.params) checkPattern(parameter);
  }
  function checkKey(node) {
    if (!node.computed) check(node.key);
  }
  return {
    FunctionDeclaration: checkFunction,
    FunctionExpression: checkFunction,
    ArrowFunctionExpression: checkFunction,
    VariableDeclarator: (node) => checkPattern(node.id),
    ClassDeclaration: (node) => check(node.id),
    TSInterfaceDeclaration: (node) => check(node.id),
    TSTypeAliasDeclaration: (node) => check(node.id),
    MethodDefinition: checkKey,
    TSAbstractMethodDefinition: checkKey,
    PropertyDefinition: checkKey,
    TSAbstractPropertyDefinition: checkKey,
    TSPropertySignature: checkKey,
    LogicalExpression: (node) => checkDualKeyAliasRead(node, context),
  };
}

export default {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow declared names that preserve a compatibility, legacy, deprecated, or retired path.",
    },
    schema: [
      {
        type: "object",
        properties: scopeProperties,
        additionalProperties: false,
      },
    ],
    messages: {
      compatName:
        "'{{name}}' declares a compatibility or retirement path. Delete the old path instead of keeping or naming it.",
      compatNameWithCanonical:
        "'{{name}}' declares a compatibility or retirement path alongside '{{canonical}}'. Delete the old path and use '{{canonical}}' directly.",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    return createNameVisitors(context);
  },
};
