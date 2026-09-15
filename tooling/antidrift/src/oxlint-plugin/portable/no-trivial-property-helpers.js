import { isRuleFile, scopeProperties } from "./scope.js";
import {
  extractFunctionName,
  getFunctionStatements,
  getNode,
  isDefaultFallbackNode,
  isFunctionValue,
  isPropertyAccessLike,
  toNode,
  walkAst,
} from "./syntax.js";

const BANNED_NAMES = new Set([
  "getStringValue",
  "safeGet",
  "extractProp",
  "readString",
]);
const BANNED_NAME_PATTERN =
  /^(get|read|extract|safe)(String|Number|Boolean|Prop|Value|Property)$/;
const hasBannedName = (name) =>
  typeof name === "string" &&
  (BANNED_NAMES.has(name) || BANNED_NAME_PATTERN.test(name));
const isTrivialPropertyHelper = (node) => {
  const statements = getFunctionStatements(node);
  if (statements.length !== 1) {
    return false;
  }
  const statement = statements[0];
  if (!statement || statement.type !== "ReturnStatement") {
    return false;
  }
  const argument = getNode(statement, "argument");
  if (!argument) {
    return false;
  }
  let hasPropertyAccess = false;
  let hasPrimitiveTypeof = false;
  let hasFallback = false;
  walkAst(argument, (candidate) => {
    if (isPropertyAccessLike(candidate)) {
      hasPropertyAccess = true;
    }
    if (
      candidate.type === "UnaryExpression" &&
      candidate.operator === "typeof"
    ) {
      hasPrimitiveTypeof = true;
    }
    if (candidate.type === "LogicalExpression") {
      const right = toNode(candidate.right);
      if (isDefaultFallbackNode(right)) {
        hasFallback = true;
      }
    }
    if (candidate.type === "ConditionalExpression") {
      const consequent = toNode(candidate.consequent);
      const alternate = toNode(candidate.alternate);
      if (
        isDefaultFallbackNode(consequent) ||
        isDefaultFallbackNode(alternate)
      ) {
        hasFallback = true;
      }
    }
  });
  return hasPropertyAccess && (hasPrimitiveTypeof || hasFallback);
};
export const noTrivialPropertyHelpersRule = {
  meta: {
    schema: [
      {
        type: "object",
        properties: scopeProperties,
        additionalProperties: false,
      },
    ],

    type: "problem",
    docs: {
      description:
        "Disallow trivial property helpers that wrap one-line property reads with needless indirection.",
    },
    messages: {
      helper:
        "Helper '{{name}}' is a trivial property wrapper. Inline the property access or decode with schema validation.",
      call: "Call to '{{name}}' hides trivial property access logic. Inline it or decode with schema validation.",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};

    const checkFunctionLike = (node) => {
      const name = extractFunctionName(node);
      if (!hasBannedName(name) || !isTrivialPropertyHelper(node)) {
        return;
      }
      context.report({
        node,
        messageId: "helper",
        data: { name: name ?? "helper" },
      });
    };
    return {
      FunctionDeclaration(node) {
        checkFunctionLike(node);
      },
      MethodDefinition(node) {
        checkFunctionLike(node);
      },
      VariableDeclarator(node) {
        const initNode = getNode(node, "init");
        if (!initNode || !isFunctionValue(initNode)) {
          return;
        }
        checkFunctionLike(node);
      },
    };
  },
};
export default noTrivialPropertyHelpersRule;
