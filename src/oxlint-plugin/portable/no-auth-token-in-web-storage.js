import { isRuleFile, scopeProperties } from "../shared/rule-scope.js";
import {
  getPropertyName,
  isAstNode,
  isIdentifier,
  isStringLiteral,
  unwrapExpression,
} from "./ast.js";

const STORAGE_NAMES = new Set(["localStorage", "sessionStorage"]);
const GLOBAL_HOST_NAMES = new Set(["globalThis", "self", "window"]);
const CREDENTIAL_KEY_PATTERN =
  /token|jwt|secret|password|passwd|credential|api[-_]?key|bearer|private[-_]?key/iu;
const NON_CREDENTIAL_TOKEN_PATTERN =
  /csrf|xsrf|device|fcm|apns|push|design|tokeniz|syntax|css|theme|color/iu;
const STRONG_CREDENTIAL_KEY_PATTERN =
  /jwt|secret|password|passwd|credential|private[-_]?key|api[-_]?key|bearer|access[-_]?token|refresh[-_]?token|auth[-_]?token|id[-_]?token|session/iu;
const staticTemplateText = (node) => {
  if (
    !isAstNode(node) ||
    node.type !== "TemplateLiteral" ||
    !Array.isArray(node.expressions) ||
    node.expressions.length !== 0 ||
    !Array.isArray(node.quasis) ||
    node.quasis.length !== 1
  ) {
    return null;
  }
  const quasi = node.quasis.at(0);
  if (
    !isAstNode(quasi) ||
    quasi.type !== "TemplateElement" ||
    typeof quasi.value !== "object" ||
    quasi.value === null ||
    !("cooked" in quasi.value)
  ) {
    return null;
  }
  return typeof quasi.value.cooked === "string" ? quasi.value.cooked : null;
};
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
  resolveVariable = (identifier) => {
    let scope = this.context.sourceCode.getScope(identifier);
    while (scope !== null) {
      const binding = scope.set.get(identifier.name);
      if (binding !== undefined) {
        return binding;
      }
      scope = scope.upper;
    }
    return null;
  };

  isGlobalReference = (node, name) => {
    if (!isIdentifier(node, name)) {
      return false;
    }
    const binding = this.resolveVariable(node);
    return binding === null || binding.defs.length === 0;
  };

  resolveStaticString = (node, visited = new Set()) => {
    const expression = unwrapExpression(node);
    if (expression === null) {
      return null;
    }
    if (isStringLiteral(expression)) {
      return expression.value;
    }
    const templateText = staticTemplateText(expression);
    if (templateText !== null) {
      return templateText;
    }
    if (expression.type === "BinaryExpression" && expression.operator === "+") {
      const left = this.resolveStaticString(expression.left, new Set(visited));
      const right = this.resolveStaticString(
        expression.right,
        new Set(visited)
      );
      return left === null || right === null ? null : left + right;
    }
    if (!isIdentifier(expression)) {
      return null;
    }
    const binding = this.resolveVariable(expression);
    if (binding === null || visited.has(binding)) {
      return null;
    }
    visited.add(binding);
    for (const definition of binding.defs) {
      if (
        definition.type !== "Variable" ||
        !isAstNode(definition.node) ||
        definition.node.type !== "VariableDeclarator" ||
        !isAstNode(definition.parent) ||
        definition.parent.type !== "VariableDeclaration" ||
        definition.parent.kind !== "const"
      ) {
        continue;
      }
      return this.resolveStaticString(definition.node.init, visited);
    }
    return null;
  };

  resolveMemberName = (node) => {
    const member = unwrapExpression(node);
    if (member === null || member.type !== "MemberExpression") {
      return null;
    }
    return member.computed === true
      ? this.resolveStaticString(member.property)
      : getPropertyName(member.property);
  };

  isBrowserGlobalHost = (node, visited = new Set()) => {
    const expression = unwrapExpression(node);
    if (expression === null) {
      return false;
    }
    if (isIdentifier(expression) && GLOBAL_HOST_NAMES.has(expression.name)) {
      return this.isGlobalReference(expression, expression.name);
    }
    if (expression.type === "MemberExpression") {
      const memberName = this.resolveMemberName(expression);
      return (
        memberName !== null &&
        GLOBAL_HOST_NAMES.has(memberName) &&
        this.isBrowserGlobalHost(expression.object, visited)
      );
    }
    if (!isIdentifier(expression)) {
      return false;
    }
    const binding = this.resolveVariable(expression);
    if (binding === null || visited.has(binding)) {
      return false;
    }
    visited.add(binding);
    for (const definition of binding.defs) {
      if (
        definition.type !== "Variable" ||
        !isAstNode(definition.node) ||
        definition.node.type !== "VariableDeclarator" ||
        !isAstNode(definition.parent) ||
        definition.parent.type !== "VariableDeclaration" ||
        definition.parent.kind !== "const"
      ) {
        continue;
      }
      return this.isBrowserGlobalHost(definition.node.init, visited);
    }
    return false;
  };

  isWebStorage = (node, visited = new Set()) => {
    const expression = unwrapExpression(node);
    if (expression === null) {
      return false;
    }
    if (isIdentifier(expression) && STORAGE_NAMES.has(expression.name)) {
      return this.isGlobalReference(expression, expression.name);
    }
    if (isIdentifier(expression)) {
      const binding = this.resolveVariable(expression);
      if (binding === null || visited.has(binding)) {
        return false;
      }
      visited.add(binding);
      for (const definition of binding.defs) {
        if (
          definition.type !== "Variable" ||
          !isAstNode(definition.node) ||
          definition.node.type !== "VariableDeclarator" ||
          !isAstNode(definition.parent) ||
          definition.parent.type !== "VariableDeclaration" ||
          definition.parent.kind !== "const"
        ) {
          continue;
        }
        return this.isWebStorage(definition.node.init, visited);
      }
      return false;
    }
    if (expression.type !== "MemberExpression") {
      return false;
    }
    const storageName = this.resolveMemberName(expression);
    if (storageName === null || !STORAGE_NAMES.has(storageName)) {
      return false;
    }
    return this.isBrowserGlobalHost(expression.object);
  };

  reportCredentialName = (node, keyName) => {
    if (keyName === null || !isCredentialKey(keyName)) {
      return;
    }
    this.context.report({ node, messageId: "noAuthTokenInWebStorage" });
  };

  reportCredentialKey = (node, key) => {
    this.reportCredentialName(node, this.resolveStaticString(key));
  };

  visitCallExpression = (node) => {
    const callee = unwrapExpression(node.callee);
    if (
      callee === null ||
      callee.type !== "MemberExpression" ||
      this.resolveMemberName(callee) !== "setItem" ||
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
    this.reportCredentialName(node, this.resolveMemberName(target));
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
