import { isRuleFile, scopeProperties } from "../shared/rule-scope.js";
import {
  getCallChain,
  getFunctionStatements,
  getIdentifierName,
  getLiteralString,
  getMemberPropertyName,
  getNode,
  getNodeArray,
  getString,
  isFunctionExpression,
  isTestFilename,
  unwrapChainExpression,
} from "./syntax.js";
import { emptyFailureFallbackVisitors } from "./empty-failure-fallback.js";
import { mergeVisitors } from "../shared/merge-visitors.js";

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
const DECODE_METHOD = /^(?:parse|parseAsync|decodeUnknownSync|decodeSync)$/u;
const NON_SCHEMA_RECEIVER = /^(?:Date|URL|path|Number|BigInt|Temporal)$/u;
const PROCESS_FALLBACK_FIELDS = new Set(["stdout", "stderr", "code"]);
const PROCESS_FALLBACK_TARGETS = new Set(["stdout", "stderr", "message"]);

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
  return (
    target?.type === "MemberExpression" &&
    getIdentifierName(target.object) === errorName &&
    allowedProperties.has(getMemberPropertyName(target))
  );
}

function isBareCaughtErrorCall(target, errorName) {
  const args = getNodeArray(target, "arguments");
  if (args.length === 0) {
    return isErrorMemberRead(target.callee, errorName, new Set(["toString"]));
  }
  return (
    getIdentifierName(target.callee) === "String" &&
    args.length === 1 &&
    (getIdentifierName(args[0]) === errorName ||
      isErrorMemberRead(args[0], errorName, new Set(["message"])))
  );
}

function isBareCaughtErrorTemplate(target, errorName) {
  const expressions = getNodeArray(target, "expressions");
  const quasis = getNodeArray(target, "quasis");
  const staticText = quasis
    .map((quasi) => getString(quasi.value?.raw) ?? "")
    .join("")
    .trim();
  return (
    staticText.length === 0 &&
    expressions.length === 1 &&
    isBareCaughtErrorMessage(expressions[0], errorName)
  );
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
  if (
    target.type === "CallExpression" &&
    isBareCaughtErrorCall(target, errorName)
  ) {
    return true;
  }
  if (target.type === "TemplateLiteral") {
    return isBareCaughtErrorTemplate(target, errorName);
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
  const parent = getNode(node, "parent");
  const isCatchCallback =
    isFunctionExpression(node) &&
    parent?.type === "CallExpression" &&
    getNodeArray(parent, "arguments")[0] === node &&
    getMemberPropertyName(parent.callee) === "catch";
  const firstParameter = getNodeArray(node, "params")[0];
  return isCatchCallback && firstParameter
    ? getIdentifierName(firstParameter)
    : null;
}

function returnedDecodeCallee(statement) {
  const call = unwrapChainExpression(
    statement?.type === "ReturnStatement" ? statement.argument : null
  );
  const callee = call?.type === "CallExpression" ? call.callee : null;
  const method = getMemberPropertyName(callee);
  const receiver = getIdentifierName(getNode(callee ?? {}, "object"));
  if (!method || !DECODE_METHOD.test(method)) return null;
  if (NON_SCHEMA_RECEIVER.test(receiver ?? "")) return null;
  return receiver ? `${receiver}.${method}` : method;
}

const EMPTY_COLLECTION_TEXT = { ArrayExpression: "[]", ObjectExpression: "{}" };

function nullishSentinel(statements, hasCatchBinding) {
  const exit = statements.at(-1);
  if (exit?.type !== "ReturnStatement") return null;
  const sentinel = unwrapChainExpression(exit.argument);
  if (!sentinel || getIdentifierName(sentinel) === "undefined") {
    return "undefined";
  }
  if (sentinel.type === "Literal" && sentinel.value === null) return "null";
  const empty = (sentinel.elements ?? sentinel.properties)?.length === 0;
  return empty && hasCatchBinding
    ? (EMPTY_COLLECTION_TEXT[sentinel.type] ?? null)
    : null;
}

function catchReportsFailure(statements, errorName) {
  return statements.some(
    (statement) =>
      statement.type === "ThrowStatement" ||
      isLoggerStatementForError(statement, errorName)
  );
}

class ErrorDiagnostics {
  constructor(context) {
    this.context = context;
    this.catchParamStack = [];
  }
  enterPromiseCatchCallback = (node) => {
    const errorName = promiseCatchCallbackParamName(node);
    if (!errorName) {
      return;
    }
    this.catchParamStack.push(errorName);
    inspectCatchStatements(
      getFunctionStatements(node),
      errorName,
      this.context
    );
  };

  exitPromiseCatchCallback = (node) => {
    if (promiseCatchCallbackParamName(node)) {
      this.catchParamStack.pop();
    }
  };

  visitCatchClause = (node) => {
    const errorName = getIdentifierName(node.param);
    if (!errorName) {
      return;
    }
    this.catchParamStack.push(errorName);
    const body = getNode(node, "body");
    if (body && body.type === "BlockStatement") {
      inspectCatchStatements(
        getNodeArray(body, "body"),
        errorName,
        this.context
      );
    }
  };

  visitTryStatement = (node) => {
    const handler = getNode(node, "handler");
    const block = getNodeArray(getNode(node, "block") ?? {}, "body");
    const callee = returnedDecodeCallee(block.at(-1));
    const statements = getNodeArray(
      getNode(handler ?? {}, "body") ?? {},
      "body"
    );
    const errorName = getIdentifierName(handler?.param);
    const sentinel = callee
      ? nullishSentinel(statements, errorName !== null)
      : null;
    if (sentinel && !catchReportsFailure(statements, errorName)) {
      this.context.report({
        node,
        messageId: "decodeToNullable",
        data: { callee, sentinel },
      });
    }
  };

  visitLogicalExpression = (node) => {
    const errorName = this.catchParamStack.at(-1);
    const left = unwrapChainExpression(node.left);
    const right = unwrapChainExpression(node.right);
    const field = getMemberPropertyName(left);
    if (
      !errorName ||
      (node.operator !== "||" && node.operator !== "??") ||
      getIdentifierName(left?.object) !== errorName ||
      !PROCESS_FALLBACK_FIELDS.has(field)
    ) {
      return;
    }
    const fallsBack =
      (field === "code" && Boolean(getLiteralString(right))) ||
      (getIdentifierName(right?.object) === errorName &&
        PROCESS_FALLBACK_TARGETS.has(getMemberPropertyName(right)));
    if (fallsBack) {
      this.context.report({
        node,
        messageId: "catchErrorCodeOrStdoutFallback",
        data: { name: errorName, field },
      });
    }
  };

  visitCatchClauseexit = (node) => {
    if (getIdentifierName(node.param)) {
      this.catchParamStack.pop();
    }
  };

  visitThrowStatement = (node) => {
    const argument = getNode(node, "argument");
    const calleeName = ["NewExpression", "CallExpression"].includes(
      argument?.type
    )
      ? getIdentifierName(argument.callee)
      : null;
    const args = BARE_ERROR_CONSTRUCTORS.has(calleeName)
      ? getNodeArray(argument, "arguments")
      : [];
    const message = args[0] ? getLiteralString(args[0]) : null;
    if (
      calleeName === "Error" &&
      message &&
      VAGUE_ERROR_PATTERN.test(message)
    ) {
      this.context.report({
        node,
        messageId: "anemicThrow",
        data: { message },
      });
      return;
    }
    const activeCatchParam = this.catchParamStack.at(-1);
    if (
      activeCatchParam &&
      args.length === 1 &&
      isBareCaughtErrorMessage(args[0], activeCatchParam)
    ) {
      this.context.report({
        node,
        messageId: "lossyErrorRethrow",
        data: { name: activeCatchParam },
      });
    }
  };

  visitReturnStatement = (node) => {
    const returned = getNode(node, "argument");
    if (returned?.type !== "ObjectExpression") return;
    let hasSuccessFalse = false;
    let hasVagueError = false;
    for (const prop of getNodeArray(returned, "properties")) {
      const keyName = getIdentifierName(prop.key) ?? getLiteralString(prop.key);
      const initializer = getNode(prop, "value");
      if (keyName === "success" && initializer?.type === "Literal") {
        hasSuccessFalse ||= initializer.value === false;
      }
      if (keyName === "error") {
        hasVagueError ||= VAGUE_ERROR_PATTERN.test(
          getString(initializer?.value) ?? ""
        );
      }
    }
    if (hasSuccessFalse && hasVagueError) {
      this.context.report({ node, messageId: "anemicReturn" });
    }
  };

  listeners() {
    return {
      CatchClause: this.visitCatchClause,
      "CatchClause:exit": this.visitCatchClauseexit,
      ArrowFunctionExpression: this.enterPromiseCatchCallback,
      "ArrowFunctionExpression:exit": this.exitPromiseCatchCallback,
      FunctionExpression: this.enterPromiseCatchCallback,
      "FunctionExpression:exit": this.exitPromiseCatchCallback,
      ThrowStatement: this.visitThrowStatement,
      ReturnStatement: this.visitReturnStatement,
      TryStatement: this.visitTryStatement,
      LogicalExpression: this.visitLogicalExpression,
    };
  }
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
        "Disallow vague errors, lossy rewrapping, catch-log-rethrow duplication, empty success-shaped failure returns, decode-to-nullable collapses, and catch-side error-code/stdout fallbacks.",
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
      decodeToNullable:
        "Boundary decode '{{callee}}' is collapsed to {{sentinel}}, erasing schema and syntax failures into absence; propagate or report the decode error explicitly.",
      catchErrorCodeOrStdoutFallback:
        "Catch block falls back from '{{name}}.{{field}}' to another error field or a sentinel code; rethrow or return a typed failure instead of collapsing process output and error codes.",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    if (isTestFilename(context.filename)) {
      return emptyFailureFallbackVisitors(context);
    }
    return mergeVisitors(
      emptyFailureFallbackVisitors(context),
      new ErrorDiagnostics(context).listeners()
    );
  },
};
export default noAnemicErrorsRule;
