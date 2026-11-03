import { isRuleFile, scopeProperties } from "../shared/rule-scope.js";
import {
  constInitializer,
  findVariable,
  unwrapExpression,
} from "../shared/scope.js";
import { isIdentifier } from "./ast.js";
import {
  isBrowserGlobalHost,
  isGlobalReference,
  resolveStaticString,
  resolveStaticMemberName,
} from "./static-resolution.js";

const STORAGE_NAMES = new Set(["localStorage", "sessionStorage"]);
const CREDENTIAL_KEY_PATTERN =
  /token|jwt|secret|password|passwd|credential|api[-_]?key|bearer|private[-_]?key/iu;
const NON_CREDENTIAL_TOKEN_PATTERN =
  /csrf|xsrf|device|fcm|apns|push|design|tokeniz|syntax|css|theme|color/iu;
const STRONG_CREDENTIAL_KEY_PATTERN =
  /jwt|secret|password|passwd|credential|private[-_]?key|api[-_]?key|bearer|access[-_]?token|refresh[-_]?token|auth[-_]?token|id[-_]?token|session/iu;
const isCredentialKey = (key) => {
  if (!CREDENTIAL_KEY_PATTERN.test(key)) {
    return false;
  }
  return (
    !NON_CREDENTIAL_TOKEN_PATTERN.test(key) ||
    STRONG_CREDENTIAL_KEY_PATTERN.test(key)
  );
};
class WebStorageCredentials {
  constructor(context) {
    this.context = context;
  }
  isWebStorage = (node, visited = new Set()) => {
    const sourceCode = this.context.sourceCode;
    const expression = unwrapExpression(node);
    if (expression === null) {
      return false;
    }
    if (isIdentifier(expression) && STORAGE_NAMES.has(expression.name)) {
      return isGlobalReference(sourceCode, expression);
    }
    if (isIdentifier(expression)) {
      const binding = findVariable(sourceCode, expression);
      if (binding === null || visited.has(binding)) {
        return false;
      }
      visited.add(binding);
      return this.isWebStorage(
        constInitializer(sourceCode, expression),
        visited
      );
    }
    if (expression.type !== "MemberExpression") {
      return false;
    }
    const storageName = resolveStaticMemberName(sourceCode, expression);
    if (storageName === null || !STORAGE_NAMES.has(storageName)) {
      return false;
    }
    return isBrowserGlobalHost(sourceCode, expression.object);
  };

  reportCredentialName = (node, keyName) => {
    if (keyName === null || !isCredentialKey(keyName)) {
      return;
    }
    this.context.report({ node, messageId: "noAuthTokenInWebStorage" });
  };

  reportCredentialKey = (node, key) => {
    this.reportCredentialName(
      node,
      resolveStaticString(this.context.sourceCode, key)
    );
  };

  visitCallExpression = (node) => {
    const callee = unwrapExpression(node.callee);
    if (
      callee === null ||
      callee.type !== "MemberExpression" ||
      resolveStaticMemberName(this.context.sourceCode, callee) !== "setItem" ||
      !this.isWebStorage(callee.object) ||
      !Array.isArray(node.arguments) ||
      node.arguments.length < 2
    ) {
      return;
    }
    this.reportCredentialKey(node, node.arguments.at(0));
  };

  visitAssignmentExpression = (node) => {
    const target = unwrapExpression(node.left);
    if (
      target === null ||
      target.type !== "MemberExpression" ||
      !this.isWebStorage(target.object)
    ) {
      return;
    }
    this.reportCredentialName(
      node,
      resolveStaticMemberName(this.context.sourceCode, target)
    );
  };
  listeners() {
    return {
      CallExpression: this.visitCallExpression,
      AssignmentExpression: this.visitAssignmentExpression,
    };
  }
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
      noAuthTokenInWebStorage:
        "Do not store authentication credentials in localStorage or " +
        "sessionStorage; any script running in the page can read and " +
        "exfiltrate them. Use a server-set HttpOnly, Secure, SameSite " +
        "cookie instead.",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    return new WebStorageCredentials(context).listeners();
  },
};
