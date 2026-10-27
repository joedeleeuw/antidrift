import {
  isRuleFile,
  scopeProperties,
} from "../../semantic-adapters/kernel/rule-scope.ts";
import {
  getCallChain,
  getFunctionStatements,
  getIdentifierName,
  getLiteralString,
  getMemberPropertyName,
  getNode,
  getNodeArray,
  getString,
  isFunctionValue,
  isTestFilename,
  unwrapChainExpression,
} from "./syntax.js";
import { emptyFailureFallbackVisitors } from "./empty-failure-fallback.js";
import { mergeVisitors } from "../../semantic-adapters/kernel/merge-visitors.mjs";

const VAGUE_ERROR_PATTERN =
  /^(failed|error|something went wrong|an error occurred|unknown error|unexpected error|oops|failure|internal error|server error)$/i;

const BARE_ERROR_CONSTRUCTORS = new Set([
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
]);

const LOGGER_OBJECTS = new Set(["console", "logger", "log"]);

const LOGGER_METHODS = new Set([
  "debug",
  "error",
  "fatal",
  "info",
  "log",
  "trace",
  "warn",
]);

function isErrorMemberRead(node, errorName, allowedProperties) {
  const target = unwrapChainExpression(node);
  if (!target || target.type !== "MemberExpression") {
    return false;
  }
  if (getIdentifierName(target.object) !== errorName) {
    return false;
  }
  const propertyName = getMemberPropertyName(target);
  return propertyName !== null && allowedProperties.has(propertyName);
}

function isBareCaughtErrorMessage(node, errorName) {
  const target = unwrapChainExpression(node);
  if (!target) {
    return false;
  }
  if (getIdentifierName(target) === errorName) {
    return true;
  }
  if (isErrorMemberRead(target, errorName, new Set(["message", "stack"]))) {
    return true;
  }
  if (target.type === "CallExpression") {
    const args = getNodeArray(target, "arguments");
    if (
      getIdentifierName(target.callee) === "String" &&
      args.length === 1 &&
      (getIdentifierName(args[0]) === errorName ||
        isErrorMemberRead(args[0], errorName, new Set(["message"])))
    ) {
      return true;
    }
    if (
      args.length === 0 &&
      isErrorMemberRead(target.callee, errorName, new Set(["toString"]))
    ) {
      return true;
    }
  }
  if (target.type === "TemplateLiteral") {
    const expressions = getNodeArray(target, "expressions");
    const quasis = getNodeArray(target, "quasis");
    const staticText = quasis
      .map(
        (quasi) =>
          getString(quasi.value?.cooked) ?? getString(quasi.value?.raw) ?? ""
      )
      .join("")
      .trim();
    return (
      staticText.length === 0 &&
      expressions.length === 1 &&
      isBareCaughtErrorMessage(expressions[0], errorName)
    );
  }
  if (target.type === "ConditionalExpression") {
    return (
      isBareCaughtErrorMessage(target.consequent, errorName) &&
      isBareCaughtErrorMessage(target.alternate, errorName)
    );
  }
  if (
    target.type === "LogicalExpression" &&
    (target.operator === "??" || target.operator === "||")
  ) {
    return (
      isBareCaughtErrorMessage(target.left, errorName) &&
      (isBareCaughtErrorMessage(target.right, errorName) ||
        getLiteralString(target.right) !== null)
    );
  }
  return false;
}

function isLoggerStatementForError(statement, errorName) {
  if (!statement || statement.type !== "ExpressionStatement") {
    return false;
  }
  let expression = getNode(statement, "expression");
  if (expression?.type === "AwaitExpression") {
    expression = getNode(expression, "argument");
  }
  if (!expression || expression.type !== "CallExpression") {
    return false;
  }
  const chain = getCallChain(expression.callee);
  if (!chain || chain.members.length === 0) {
    return false;
  }
  const methodName = chain.members[chain.members.length - 1];
  const receiverName =
    chain.members.length === 1
      ? chain.rootIdentifier
      : chain.members[chain.members.length - 2];
  if (
    !methodName ||
    !receiverName ||
    !LOGGER_OBJECTS.has(receiverName) ||
    !LOGGER_METHODS.has(methodName)
  ) {
    return false;
  }
  const args = getNodeArray(expression, "arguments");
  return args.some(
    (arg) =>
      getIdentifierName(arg) === errorName ||
      isErrorMemberRead(arg, errorName, new Set(["message", "stack"]))
  );
}

function inspectCatchStatements(statements, errorName, context) {
  if (statements.length !== 2) {
    return;
  }
  const [firstStatement, secondStatement] = statements;
  if (
    secondStatement.type === "ThrowStatement" &&
    getIdentifierName(secondStatement.argument) === errorName &&
    isLoggerStatementForError(firstStatement, errorName)
  ) {
    context.report({
      node: secondStatement,
      messageId: "catchLogRethrow",
      data: { name: errorName },
    });
  }
}

function promiseCatchCallbackParamName(node) {
  if (!isFunctionValue(node)) {
    return null;
  }
  const parent = getNode(node, "parent");
  if (!parent || parent.type !== "CallExpression") {
    return null;
  }
  const args = getNodeArray(parent, "arguments");
  if (args[0] !== node || getMemberPropertyName(parent.callee) !== "catch") {
    return null;
  }
  const callbackParameters = getNodeArray(node, "params");
  return callbackParameters.length >= 1
    ? getIdentifierName(callbackParameters[0])
    : null;
}

const noAnemicErrorsRule = {
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
        "Disallow vague errors, lossy rewrapping, catch-log-rethrow duplication, and empty success-shaped failure returns.",
    },
    messages: {
      anemicThrow:
        "Error message '{{message}}' is too vague. Include context about what failed and why.",
      anemicReturn:
        "Returning a generic error object is forbidden. Include the failed operation and its input context in the returned error contract.",
      lossyErrorRethrow:
        "Re-throwing caught error '{{name}}' as a bare `new Error({{name}}.message)` discards its stack trace, cause chain, and error class with no added context. Rethrow `{{name}}` directly, wrap with `{ cause: {{name}} }` and domain context, or throw a typed domain error.",
      catchLogRethrow:
        "Logging caught error '{{name}}' and immediately re-throwing it unmodified duplicates error logging across every frame on the call stack. Either handle the error here, wrap it with domain context and `{ cause: {{name}} }`, or let it propagate and log once at the boundary.",
      fallback:
        "Failure path drops the error and returns an empty collection, which makes bad data look valid. Let the error propagate or return a typed failure.",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};

    const catchParamStack = [];

    function enterPromiseCatchCallback(node) {
      const errorName = promiseCatchCallbackParamName(node);
      if (!errorName) {
        return;
      }
      catchParamStack.push(errorName);
      inspectCatchStatements(getFunctionStatements(node), errorName, context);
    }

    function exitPromiseCatchCallback(node) {
      if (promiseCatchCallbackParamName(node)) {
        catchParamStack.pop();
      }
    }

    if (isTestFilename(context.filename)) {
      return emptyFailureFallbackVisitors(context);
    }
    const anemicVisitors = {
      CatchClause(node) {
        const errorName = getIdentifierName(node.param);
        if (!errorName) {
          return;
        }
        catchParamStack.push(errorName);
        const body = getNode(node, "body");
        if (body && body.type === "BlockStatement") {
          inspectCatchStatements(
            getNodeArray(body, "body"),
            errorName,
            context
          );
        }
      },
      "CatchClause:exit"(node) {
        if (getIdentifierName(node.param)) {
          catchParamStack.pop();
        }
      },
      ArrowFunctionExpression: enterPromiseCatchCallback,
      "ArrowFunctionExpression:exit": exitPromiseCatchCallback,
      FunctionExpression: enterPromiseCatchCallback,
      "FunctionExpression:exit": exitPromiseCatchCallback,
      ThrowStatement(node) {
        const argument = getNode(node, "argument");
        if (
          !argument ||
          !["NewExpression", "CallExpression"].includes(argument.type)
        ) {
          return;
        }
        const calleeName = getIdentifierName(argument.callee);
        if (!calleeName || !BARE_ERROR_CONSTRUCTORS.has(calleeName)) {
          return;
        }
        const args = getNodeArray(argument, "arguments");
        const firstArg = args[0];
        if (!firstArg) {
          return;
        }
        const message = getLiteralString(firstArg);
        if (
          calleeName === "Error" &&
          message &&
          VAGUE_ERROR_PATTERN.test(message)
        ) {
          context.report({
            node,
            messageId: "anemicThrow",
            data: { message },
          });
          return;
        }
        const activeCatchParam = catchParamStack[catchParamStack.length - 1];
        if (
          activeCatchParam &&
          args.length === 1 &&
          isBareCaughtErrorMessage(firstArg, activeCatchParam)
        ) {
          context.report({
            node,
            messageId: "lossyErrorRethrow",
            data: { name: activeCatchParam },
          });
        }
      },
      ReturnStatement(node) {
        const returnVal = getNode(node, "argument");
        if (!returnVal || returnVal.type !== "ObjectExpression") {
          return;
        }
        const properties = getNodeArray(returnVal, "properties");
        let hasSuccessFalse = false;
        let hasVagueError = false;
        for (const prop of properties) {
          const keyName =
            getIdentifierName(prop.key) ?? getLiteralString(prop.key);
          if (!keyName) {
            continue;
          }
          if (keyName === "success") {
            const propertyInitializer = getNode(prop, "value");
            if (
              propertyInitializer &&
              propertyInitializer.type === "Literal" &&
              propertyInitializer.value === false
            ) {
              hasSuccessFalse = true;
            }
          }
          if (keyName === "error") {
            const propertyInitializer = getNode(prop, "value");
            if (!propertyInitializer) {
              continue;
            }
            const errorStr = getString(propertyInitializer.value);
            if (errorStr && VAGUE_ERROR_PATTERN.test(errorStr)) {
              hasVagueError = true;
            }
          }
        }
        if (hasSuccessFalse && hasVagueError) {
          context.report({ node, messageId: "anemicReturn" });
        }
      },
    };
    return mergeVisitors(emptyFailureFallbackVisitors(context), anemicVisitors);
  },
};
export default noAnemicErrorsRule;
