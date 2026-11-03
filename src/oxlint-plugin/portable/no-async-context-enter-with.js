import { isRuleFile, scopeProperties } from "../shared/rule-scope.js";
import { isFunctionLike } from "../shared/scope.js";
import { isIdentifier } from "./ast.js";

const SIGNAL_NAMES = new Set(["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"]);
const SYNC_FS_METHODS = new Set([
  "appendFileSync",
  "writeFileSync",
  "mkdirSync",
]);
const LOGGER_FN_RE = /(?:^|[a-z])(?:log|logger|audit)(?:[A-Z]|$)/u;

function isInsideSignalHandler(node) {
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (
      cur.type === "CallExpression" &&
      cur.callee?.type === "MemberExpression" &&
      !cur.callee.computed &&
      isIdentifier(cur.callee.object, "process") &&
      (isIdentifier(cur.callee.property, "on") ||
        isIdentifier(cur.callee.property, "once")) &&
      cur.arguments[0]?.type === "Literal" &&
      SIGNAL_NAMES.has(cur.arguments[0].value)
    ) {
      return true;
    }
  }
  return false;
}

function enclosingFunctionName(node) {
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (!isFunctionLike(cur)) continue;
    if (cur.id?.name) return cur.id.name;
    if (
      cur.parent?.type === "VariableDeclarator" &&
      cur.parent.id?.type === "Identifier"
    ) {
      return cur.parent.id.name;
    }
    if (
      cur.parent?.type === "MethodDefinition" &&
      cur.parent.key?.type === "Identifier"
    ) {
      return cur.parent.key.name;
    }
  }
  return "";
}

function isInsideTryBlock(node) {
  for (let cur = node.parent; cur && !isFunctionLike(cur); cur = cur.parent) {
    if (cur.type === "TryStatement") return true;
  }
  return false;
}

function isSyncFsCall(callee) {
  if (callee?.type === "Identifier") return SYNC_FS_METHODS.has(callee.name);
  return (
    callee?.type === "MemberExpression" &&
    !callee.computed &&
    callee.property?.type === "Identifier" &&
    SYNC_FS_METHODS.has(callee.property.name)
  );
}

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
    messages: {
      noEnterWith:
        "Do not use AsyncLocalStorage.enterWith(): it mutates the ambient " +
        "async context frame with no restore point, so background work " +
        "that resumes there adopts the store. Scope it with run(...) at " +
        "the boundary instead (see request-scope.ts).",
      noAppExitInSignalHandler:
        "Do not call app.exit() inside a process signal handler; run graceful shutdown hooks before terminating.",
      unguardedSyncFsInLogger:
        "Synchronous filesystem write inside a logger/audit function is unguarded and can crash callers on I/O errors.",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};

    return {
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type === "MemberExpression" &&
          !callee.computed &&
          isIdentifier(callee.property, "enterWith")
        ) {
          context.report({ node, messageId: "noEnterWith" });
          return;
        }
        if (
          callee.type === "MemberExpression" &&
          !callee.computed &&
          isIdentifier(callee.object, "app") &&
          isIdentifier(callee.property, "exit") &&
          isInsideSignalHandler(node)
        ) {
          context.report({ node, messageId: "noAppExitInSignalHandler" });
          return;
        }
        if (
          isSyncFsCall(callee) &&
          !isInsideTryBlock(node) &&
          LOGGER_FN_RE.test(enclosingFunctionName(node))
        ) {
          context.report({ node, messageId: "unguardedSyncFsInLogger" });
        }
      },
    };
  },
};
