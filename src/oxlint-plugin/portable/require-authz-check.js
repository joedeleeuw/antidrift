import { isRuleFile, scopeProperties } from "../shared/rule-scope.js";
import {
  calleeName,
  findVariable,
  isFunctionLike,
  unwrapExpression,
} from "../shared/scope.js";
import { findDescendant } from "./ast.js";

const REQUEST_PARAM_ROOTS = new Set([
  "req",
  "request",
  "ctx",
  "context",
  "event",
]);
const IPC_REGISTRARS = new Set(["handle", "on", "once"]);
const PRIVILEGED_MODULES = new Set([
  "BrowserWindow",
  "desktopCapturer",
  "shell",
  "dialog",
  "session",
  "cookies",
  "webContents",
  "fs",
  "fsPromises",
  "child_process",
]);
const PRIVILEGED_CALL =
  /^(?:openExternal|openPath|clearStorageData|clearCache|getSources|fetch|(?:exec|spawn|writeFile|rm|unlink)\w*)$/u;
const PATTERN_RECEIVER = /(?:^re|Re|Regex|RegExp|Pattern|Matcher)$/u;
const SAFE_LOOKUP_METHODS = new Set([
  "fromWebContents",
  "fromId",
  "getFocusedWindow",
]);
const GUARD_HELPER_PREFIX =
  /^(?:isTrusted|isAllowed|assert|verify|validate|require|check|ensure)|sender|frame|origin|auth/iu;

function isIpcMainRegistration(node) {
  const callee = node.callee;
  return (
    callee?.type === "MemberExpression" &&
    !callee.computed &&
    callee.object?.type === "Identifier" &&
    callee.object.name === "ipcMain" &&
    callee.property?.type === "Identifier" &&
    IPC_REGISTRARS.has(callee.property.name) &&
    node.arguments.length >= 2
  );
}

function isSenderOrFrameAccess(candidate, eventParamName) {
  return (
    candidate.type === "MemberExpression" &&
    !candidate.computed &&
    candidate.object?.type === "Identifier" &&
    candidate.object.name === eventParamName &&
    candidate.property?.type === "Identifier" &&
    (candidate.property.name === "sender" ||
      candidate.property.name === "senderFrame")
  );
}

function isGuardCallOnEvent(candidate, eventParamName) {
  return (
    candidate.type === "CallExpression" &&
    GUARD_HELPER_PREFIX.test(calleeName(candidate)) &&
    candidate.arguments.some(
      (arg) => arg.type === "Identifier" && arg.name === eventParamName
    )
  );
}

function referencesSenderOrFrame(node, eventParamName) {
  return (
    findDescendant(
      node,
      (candidate) =>
        isSenderOrFrameAccess(candidate, eventParamName) ||
        isGuardCallOnEvent(candidate, eventParamName)
    ) !== null
  );
}

function terminatesControlFlow(stmt) {
  if (!stmt) return false;
  if (stmt.type === "ReturnStatement" || stmt.type === "ThrowStatement") {
    return true;
  }
  if (stmt.type === "BlockStatement" && stmt.body.length > 0) {
    return terminatesControlFlow(stmt.body.at(-1));
  }
  return false;
}

function isGuardCallStatement(stmt, eventParamName, authzSet) {
  if (stmt.type !== "ExpressionStatement") return false;
  const rawExpr = stmt.expression;
  const expr = rawExpr?.type === "AwaitExpression" ? rawExpr.argument : rawExpr;
  if (expr?.type !== "CallExpression") return false;
  const name = calleeName(expr);
  const isGuardName =
    name && (GUARD_HELPER_PREFIX.test(name) || authzSet.has(name));
  const passesEventOrSender = expr.arguments.some(
    (arg) =>
      (arg.type === "Identifier" && arg.name === eventParamName) ||
      referencesSenderOrFrame(arg, eventParamName)
  );
  return Boolean(isGuardName && passesEventOrSender);
}

function hasPrivilegedReceiver(expr) {
  let cur = expr;
  while (cur) {
    if (cur.type === "Identifier" && PRIVILEGED_MODULES.has(cur.name)) {
      return true;
    }
    if (cur.type === "MemberExpression") {
      if (
        !cur.computed &&
        cur.property?.type === "Identifier" &&
        PRIVILEGED_MODULES.has(cur.property.name)
      ) {
        return true;
      }
      cur = cur.object;
      continue;
    }
    if (cur.type === "CallExpression") {
      cur = cur.callee;
      continue;
    }
    break;
  }
  return false;
}

function isPatternReceiver(receiver) {
  return (
    Boolean(receiver?.regex) ||
    (receiver?.type === "Identifier" && PATTERN_RECEIVER.test(receiver.name))
  );
}

function isPrivilegedCallNode(cur) {
  if (cur.type !== "CallExpression") return false;
  const callee = cur.callee;
  if (callee?.type === "Identifier") return PRIVILEGED_CALL.test(callee.name);
  if (
    callee?.type !== "MemberExpression" ||
    callee.computed ||
    callee.property?.type !== "Identifier" ||
    SAFE_LOOKUP_METHODS.has(callee.property.name) ||
    isPatternReceiver(callee.object)
  ) {
    return false;
  }
  return (
    PRIVILEGED_CALL.test(callee.property.name) ||
    hasPrivilegedReceiver(callee.object)
  );
}

function findPrivilegedCall(node) {
  return findDescendant(node, isPrivilegedCallNode);
}

function isNegativeSenderCheck(test) {
  if (test.type === "UnaryExpression" && test.operator === "!") return true;
  return (
    test.type === "BinaryExpression" &&
    (test.operator === "!==" || test.operator === "!=")
  );
}

function classifyIfSenderGuard(stmt, eventName) {
  if (!eventName || !referencesSenderOrFrame(stmt.test, eventName)) {
    return null;
  }
  if (!isNegativeSenderCheck(stmt.test) && !stmt.alternate) {
    return "positive-branch";
  }
  if (terminatesControlFlow(stmt.consequent) && !stmt.alternate) {
    return "early-exit";
  }
  return null;
}

function findUnguardedIpcEffect(stmts, eventName, authzSet) {
  for (const stmt of stmts) {
    if (stmt.type === "IfStatement") {
      const testEffect = findPrivilegedCall(stmt.test);
      if (testEffect) return testEffect;
      const guardKind = classifyIfSenderGuard(stmt, eventName);
      if (guardKind === "early-exit") {
        return findPrivilegedCall(stmt.consequent);
      }
      if (guardKind === "positive-branch") {
        continue;
      }
    }
    if (eventName && isGuardCallStatement(stmt, eventName, authzSet)) {
      return findPrivilegedCall(stmt);
    }
    const priv = findPrivilegedCall(stmt);
    if (priv) return priv;
  }
  return null;
}

class AuthorizationChecks {
  constructor(context) {
    this.context = context;
    this.configured = this.context.options[0]?.authzFunctions ?? [];
    if (
      !Array.isArray(this.configured) ||
      this.configured.some((name) => typeof name !== "string")
    ) {
      throw new TypeError("authzFunctions must be strings");
    }
    this.authzSet = new Set(this.configured);
    this.stack = [];
  }
  enter = (node) => {
    this.stack.push({ node, paramsAccess: null, sawAuthz: false });
  };

  exit = () => {
    const frame = this.stack.pop();
    if (this.configured.length > 0 && frame?.paramsAccess && !frame.sawAuthz) {
      this.context.report({
        node: frame.paramsAccess,
        message:
          "Handler reads request params without a configured authorization/ownership check.",
      });
    }
  };

  visitMemberExpression = (node) => {
    const frame = this.stack.at(-1);
    if (
      frame &&
      !node.computed &&
      node.property?.type === "Identifier" &&
      node.property.name === "params" &&
      node.object?.type === "Identifier" &&
      REQUEST_PARAM_ROOTS.has(node.object.name)
    ) {
      frame.paramsAccess ??= node;
    }
  };

  visitCallExpression = (node) => {
    const frame = this.stack.at(-1);
    const name = calleeName(node);
    if (frame && name && this.authzSet.has(name)) {
      frame.sawAuthz = true;
    }
    if (!isIpcMainRegistration(node)) return;
    const handler = this.resolveHandler(node.arguments[1]);
    if (!handler) return;
    const eventParam = handler.params[0];
    const eventName =
      eventParam?.type === "Identifier" ? eventParam.name : null;
    const unguarded =
      handler.body?.type === "BlockStatement"
        ? findUnguardedIpcEffect(handler.body.body, eventName, this.authzSet)
        : findPrivilegedCall(handler.body);
    if (unguarded) {
      this.context.report({
        node,
        message:
          "Privileged Electron IPC handler must validate trusted `event.sender` or `event.senderFrame` before executing host effects.",
      });
    }
  };

  resolveHandler = (argument) => {
    const handler = unwrapExpression(argument);
    if (isFunctionLike(handler)) return handler;
    if (handler?.type !== "Identifier") return null;
    const definition = findVariable(this.context.sourceCode, handler)?.defs?.[0]
      ?.node;
    if (isFunctionLike(definition)) return definition;
    const init = unwrapExpression(definition?.init);
    return isFunctionLike(init) ? init : null;
  };

  listeners() {
    return {
      FunctionDeclaration: this.enter,
      "FunctionDeclaration:exit": this.exit,
      FunctionExpression: this.enter,
      "FunctionExpression:exit": this.exit,
      ArrowFunctionExpression: this.enter,
      "ArrowFunctionExpression:exit": this.exit,
      MemberExpression: this.visitMemberExpression,
      CallExpression: this.visitCallExpression,
    };
  }
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Require an authorization/ownership check when a handler reads request params.",
    },
    schema: [
      {
        type: "object",
        properties: {
          ...scopeProperties,
          authzFunctions: {
            type: "array",
            items: { type: "string", minLength: 1 },
            uniqueItems: true,
          },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    return new AuthorizationChecks(context).listeners();
  },
};
