import { isRuleFile, scopeProperties } from "../shared/rule-scope.js";

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
const PRIVILEGED_CALLS = new Set([
  "openExternal",
  "openPath",
  "clearStorageData",
  "clearCache",
  "getSources",
  "exec",
  "execFile",
  "execSync",
  "spawn",
  "writeFile",
  "writeFileSync",
  "rm",
  "rmSync",
  "unlink",
  "fetch",
]);
const SAFE_LOOKUP_METHODS = new Set([
  "fromWebContents",
  "fromId",
  "getFocusedWindow",
]);
const GUARD_HELPER_PREFIX =
  /^(?:assert|verify|validate|require|check|ensure)/iu;

function calleeName(callee) {
  if (!callee) return null;
  if (callee.type === "Identifier") return callee.name;
  if (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property?.type === "Identifier"
  ) {
    return callee.property.name;
  }
  return null;
}

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

function referencesSenderOrFrame(node, eventParamName) {
  let found = false;
  function visit(cur) {
    if (found || !cur || typeof cur !== "object") return;
    if (
      cur.type === "MemberExpression" &&
      !cur.computed &&
      cur.object?.type === "Identifier" &&
      cur.object.name === eventParamName &&
      cur.property?.type === "Identifier" &&
      (cur.property.name === "sender" || cur.property.name === "senderFrame")
    ) {
      found = true;
      return;
    }
    for (const [k, v] of Object.entries(cur)) {
      if (k === "parent" || k === "range" || k === "loc") continue;
      if (Array.isArray(v)) {
        for (const item of v) visit(item);
      } else if (v && typeof v === "object") {
        visit(v);
      }
    }
  }
  visit(node);
  return found;
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
  const name = calleeName(expr.callee);
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

function isPrivilegedCallNode(cur) {
  if (cur.type !== "CallExpression") return false;
  const callee = cur.callee;
  if (callee?.type === "Identifier") {
    return PRIVILEGED_CALLS.has(callee.name);
  }
  if (
    callee?.type === "MemberExpression" &&
    !callee.computed &&
    callee.property?.type === "Identifier"
  ) {
    const propName = callee.property.name;
    if (SAFE_LOOKUP_METHODS.has(propName)) return false;
    return (
      PRIVILEGED_CALLS.has(propName) || hasPrivilegedReceiver(callee.object)
    );
  }
  return false;
}

function findPrivilegedCall(node) {
  let found = null;
  function visit(cur) {
    if (found || !cur || typeof cur !== "object") return;
    if (isPrivilegedCallNode(cur)) {
      found = cur;
      return;
    }
    for (const [k, v] of Object.entries(cur)) {
      if (k === "parent" || k === "range" || k === "loc") continue;
      if (Array.isArray(v)) {
        for (const item of v) visit(item);
      } else if (v && typeof v === "object") {
        visit(v);
      }
    }
  }
  visit(node);
  return found;
}

function classifyIfSenderGuard(stmt, eventName) {
  if (!eventName || !referencesSenderOrFrame(stmt.test, eventName)) {
    return null;
  }
  if (terminatesControlFlow(stmt.consequent) && !stmt.alternate) {
    return "early-exit";
  }
  const isPositiveCheck =
    stmt.test.type !== "UnaryExpression" || stmt.test.operator !== "!";
  return isPositiveCheck && !stmt.alternate ? "positive-branch" : null;
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
    const configured = context.options[0]?.authzFunctions ?? [];
    if (
      !Array.isArray(configured) ||
      configured.some((name) => typeof name !== "string")
    ) {
      throw new TypeError("authzFunctions must be strings");
    }
    const authzSet = new Set(configured);
    const stack = [];
    const enter = (node) => {
      stack.push({ node, paramsAccess: null, sawAuthz: false });
    };
    const exit = () => {
      const frame = stack.pop();
      if (configured.length > 0 && frame?.paramsAccess && !frame.sawAuthz) {
        context.report({
          node: frame.paramsAccess,
          message:
            "Handler reads request params without a configured authorization/ownership check.",
        });
      }
    };
    return {
      FunctionDeclaration: enter,
      "FunctionDeclaration:exit": exit,
      FunctionExpression: enter,
      "FunctionExpression:exit": exit,
      ArrowFunctionExpression: enter,
      "ArrowFunctionExpression:exit": exit,
      MemberExpression(node) {
        const frame = stack.at(-1);
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
      },
      CallExpression(node) {
        const frame = stack.at(-1);
        const name = calleeName(node.callee);
        if (frame && name && authzSet.has(name)) {
          frame.sawAuthz = true;
        }
        if (!isIpcMainRegistration(node)) return;
        const handler = node.arguments[1];
        if (
          handler?.type !== "ArrowFunctionExpression" &&
          handler?.type !== "FunctionExpression"
        ) {
          return;
        }
        const eventParam = handler.params[0];
        const eventName =
          eventParam?.type === "Identifier" ? eventParam.name : null;
        if (handler.body?.type !== "BlockStatement") {
          const priv = findPrivilegedCall(handler.body);
          if (priv) {
            context.report({
              node: priv,
              message:
                "Privileged Electron IPC handler must validate trusted `event.sender` or `event.senderFrame` before executing host effects.",
            });
          }
          return;
        }
        const unguarded = findUnguardedIpcEffect(
          handler.body.body,
          eventName,
          authzSet
        );
        if (unguarded) {
          context.report({
            node: unguarded,
            message:
              "Privileged Electron IPC handler must validate trusted `event.sender` or `event.senderFrame` before executing host effects.",
          });
        }
      },
    };
  },
};
