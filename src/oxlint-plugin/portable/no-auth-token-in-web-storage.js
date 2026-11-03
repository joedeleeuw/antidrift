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
const SECRET_ENV_NAME =
  /(?:SECRET|TOKEN|API_KEY|PRIVATE_KEY|PASSWORD|WEBHOOK_SECRET|SIGNING_KEY)/iu;
const EQUALITY_OPERATORS = new Set(["===", "!==", "==", "!="]);

const isNullishOrEmpty = (node) => {
  const expression = unwrapExpression(node);
  return (
    (expression?.type === "Literal" &&
      (expression.value === null || expression.value === "")) ||
    (isIdentifier(expression) && expression.name === "undefined") ||
    expression?.type === "UnaryExpression"
  );
};

const secretEnvName = (sourceCode, node) => {
  let expression = unwrapExpression(node);
  if (isIdentifier(expression)) {
    expression = unwrapExpression(constInitializer(sourceCode, expression));
  }
  if (expression?.type === "LogicalExpression") {
    expression = unwrapExpression(expression.left);
  }
  const processEnv = unwrapExpression(expression?.object);
  if (
    expression?.type !== "MemberExpression" ||
    processEnv?.type !== "MemberExpression" ||
    resolveStaticMemberName(sourceCode, processEnv) !== "env" ||
    !isIdentifier(unwrapExpression(processEnv.object), "process")
  ) {
    return null;
  }
  const envName = resolveStaticMemberName(sourceCode, expression);
  return envName && SECRET_ENV_NAME.test(envName) ? envName : null;
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
  visitBinaryExpression = (node) => {
    if (
      !EQUALITY_OPERATORS.has(node.operator) ||
      isNullishOrEmpty(node.left) ||
      isNullishOrEmpty(node.right)
    ) {
      return;
    }
    const sourceCode = this.context.sourceCode;
    const envName =
      secretEnvName(sourceCode, node.left) ??
      secretEnvName(sourceCode, node.right);
    if (envName) {
      this.context.report({
        node,
        messageId: "nonConstantTimeSecretCompare",
        data: { envName },
      });
    }
  };

  listeners() {
    return {
      CallExpression: this.visitCallExpression,
      AssignmentExpression: this.visitAssignmentExpression,
      BinaryExpression: this.visitBinaryExpression,
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
      nonConstantTimeSecretCompare:
        "Do not compare secret env variable '{{envName}}' with an equality operator; use crypto.timingSafeEqual on equal-length buffers to prevent timing side-channels.",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    return new WebStorageCredentials(context).listeners();
  },
};
