const detectionNameTokens = new Set([
  "detect",
  "discover",
  "host",
  "identity",
  "lookup",
  "machine",
  "platform",
  "probe",
  "trace",
  "uuid",
  "device",
]);

const memberNodeTypes = new Set([
  "MethodDefinition",
  "PropertyDefinition",
  "Property",
]);

function functionName(node) {
  if (node.type === "FunctionDeclaration") return node.id?.name ?? "";
  if (node.type === "VariableDeclarator" && node.id?.type === "Identifier") {
    return node.id.name;
  }
  if (memberNodeTypes.has(node.type)) {
    const key = node.key;
    if (key?.type === "Identifier" || key?.type === "PrivateIdentifier") {
      return key.name;
    }
    if (key?.type === "Literal" && typeof key.value === "string") {
      return key.value;
    }
  }
  return "";
}

function owningFunctionName(node) {
  let current = node.parent;
  while (current) {
    if (current.type === "FunctionDeclaration") return functionName(current);
    if (
      current.type === "FunctionExpression" ||
      current.type === "ArrowFunctionExpression"
    ) {
      return functionName(current.parent);
    }
    current = current.parent;
  }
  return "";
}

function isEmptyString(node) {
  return (
    (node.type === "Literal" && node.value === "") ||
    (node.type === "TemplateLiteral" &&
      node.expressions.length === 0 &&
      node.quasis.length === 1 &&
      node.quasis[0].value.cooked === "")
  );
}

function unwrapExpression(node) {
  let current = node;
  while (
    current?.type === "ChainExpression" ||
    current?.type === "TSAsExpression" ||
    current?.type === "TSSatisfiesExpression" ||
    current?.type === "TSNonNullExpression" ||
    current?.type === "TSTypeAssertion"
  ) {
    current = current.expression;
  }
  return current;
}

function containsEmptyString(node) {
  const expression = unwrapExpression(node);
  if (!expression) return false;
  if (isEmptyString(expression)) return true;
  if (expression.type === "LogicalExpression") {
    return (
      containsEmptyString(expression.left) ||
      containsEmptyString(expression.right)
    );
  }
  if (expression.type === "ConditionalExpression") {
    return (
      containsEmptyString(expression.consequent) ||
      containsEmptyString(expression.alternate)
    );
  }
  if (expression.type === "SequenceExpression") {
    return expression.expressions.some(containsEmptyString);
  }
  return false;
}

function fallbackExpressionSource(node) {
  const expression = unwrapExpression(node);
  if (!expression) return "";
  if (
    expression.type === "LogicalExpression" &&
    (expression.operator === "||" || expression.operator === "??") &&
    containsEmptyString(expression.right)
  ) {
    return "ast-logical-fallback";
  }
  if (
    expression.type === "ConditionalExpression" &&
    (containsEmptyString(expression.consequent) ||
      containsEmptyString(expression.alternate))
  ) {
    return "ast-conditional-fallback";
  }
  if (expression.type === "SequenceExpression") {
    return fallbackExpressionSource(expression.expressions.at(-1));
  }
  return "";
}

function isFailureTest(node) {
  const expression = unwrapExpression(node);
  if (!expression) return false;
  if (expression.type === "UnaryExpression" && expression.operator === "!") {
    return true;
  }
  if (expression.type === "BinaryExpression") {
    return ["!=", "!==", "==", "==="].includes(expression.operator);
  }
  if (expression.type === "LogicalExpression") {
    return isFailureTest(expression.left) || isFailureTest(expression.right);
  }
  return false;
}

function isInsideCatchClause(node) {
  let current = node.parent;
  while (current) {
    if (current.type === "CatchClause") return true;
    if (
      current.type === "FunctionDeclaration" ||
      current.type === "FunctionExpression" ||
      current.type === "ArrowFunctionExpression"
    ) {
      return false;
    }
    current = current.parent;
  }
  return false;
}

function isFailureBranchReturn(node) {
  let current = node.parent;
  while (current) {
    if (current.type === "IfStatement") {
      return isFailureTest(current.test);
    }
    if (
      current.type === "FunctionDeclaration" ||
      current.type === "FunctionExpression" ||
      current.type === "ArrowFunctionExpression" ||
      current.type === "CatchClause"
    ) {
      return false;
    }
    current = current.parent;
  }
  return false;
}

function astRecoverySource(node, expression) {
  const fallbackSource = fallbackExpressionSource(expression);
  if (fallbackSource) return fallbackSource;
  if (!containsEmptyString(expression)) return "";
  if (isInsideCatchClause(node)) return "ast-catch-recovery";
  if (isFailureBranchReturn(node)) return "ast-failure-branch";
  return "";
}

function isDetectionHelper(name) {
  const tokens = name
    .replaceAll(/([a-z\d])([A-Z])/gu, "$1 $2")
    .split(/[^A-Za-z\d]+/u)
    .map((token) => token.toLowerCase())
    .filter(Boolean);
  return tokens.some((token) => detectionNameTokens.has(token));
}

export default function ruleNoSilentEmptyDetectionFallback() {
  return {
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow empty-string fallbacks from identity, host, probe, and detection helpers",
      },
      schema: [],
      messages: {
        noSilentEmptyFallback:
          "Do not return an empty string from {{name}} (source: {{source}}). Throw or return an explicit nullable/result value so callers cannot confuse detection failure with a real value.",
      },
    },
    create(context) {
      function reportIfSilentFallback(node, expression, name) {
        if (!isDetectionHelper(name)) return;
        const source = astRecoverySource(node, expression);
        if (!source) return;
        context.report({
          node: expression,
          messageId: "noSilentEmptyFallback",
          data: { name, source },
        });
      }

      return {
        ArrowFunctionExpression(node) {
          if (node.body.type === "BlockStatement") return;
          reportIfSilentFallback(node, node.body, functionName(node.parent));
        },
        ReturnStatement(node) {
          reportIfSilentFallback(node, node.argument, owningFunctionName(node));
        },
      };
    },
  };
}
