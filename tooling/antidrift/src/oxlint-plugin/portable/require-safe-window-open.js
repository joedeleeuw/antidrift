import { isRuleFile, scopeProperties } from "./scope.js";
import {
  isAstNode,
  isIdentifier,
  isStringLiteral,
  unwrapExpression,
} from "./ast.js";

const staticTemplateValue = (node) => {
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
const staticMemberName = (member) => {
  const unwrapped = unwrapExpression(member);
  if (!unwrapped || unwrapped.type !== "MemberExpression") {
    return null;
  }
  if (unwrapped.computed === false && isIdentifier(unwrapped.property)) {
    return unwrapped.property.name;
  }
  if (unwrapped.computed !== true) {
    return null;
  }
  if (isStringLiteral(unwrapped.property)) {
    return unwrapped.property.value;
  }
  return staticTemplateValue(unwrapped.property);
};
const memberObject = (member) => {
  const unwrapped = unwrapExpression(member);
  if (!unwrapped || unwrapped.type !== "MemberExpression") {
    return null;
  }
  return unwrapped.object;
};
const sourceCodeForContext = (context) => {
  if (
    typeof context !== "object" ||
    context === null ||
    !("sourceCode" in context) ||
    typeof context.sourceCode !== "object" ||
    context.sourceCode === null
  ) {
    return null;
  }
  return context.sourceCode;
};
const bindingFromScope = (initialScope, name) => {
  let scope = initialScope;
  while (typeof scope === "object" && scope !== null) {
    if (
      "set" in scope &&
      typeof scope.set === "object" &&
      scope.set !== null &&
      "get" in scope.set &&
      typeof scope.set.get === "function"
    ) {
      const binding = scope.set.get(name);
      if (binding !== undefined) {
        return binding;
      }
    }
    scope = "upper" in scope ? scope.upper : null;
  }
  return null;
};
const bindingHasDefinitions = (binding) =>
  typeof binding === "object" &&
  binding !== null &&
  "defs" in binding &&
  Array.isArray(binding.defs) &&
  binding.defs.length > 0;
const isScopeVariable = (value) =>
  typeof value === "object" &&
  value !== null &&
  "defs" in value &&
  Array.isArray(value.defs) &&
  "references" in value &&
  Array.isArray(value.references);
const scopeVariableForReference = (context, node) => {
  if (!isIdentifier(node)) {
    return null;
  }
  const sourceCode = sourceCodeForContext(context);
  if (
    typeof sourceCode !== "object" ||
    sourceCode === null ||
    !("getScope" in sourceCode) ||
    typeof sourceCode.getScope !== "function"
  ) {
    return null;
  }
  const binding = bindingFromScope(sourceCode.getScope(node), node.name);
  return isScopeVariable(binding) ? binding : null;
};
const isGlobalReference = (context, node) => {
  if (!isIdentifier(node)) {
    return false;
  }
  const sourceCode = sourceCodeForContext(context);
  if (typeof sourceCode !== "object" || sourceCode === null) {
    return false;
  }
  if (
    "isGlobalReference" in sourceCode &&
    typeof sourceCode.isGlobalReference === "function" &&
    sourceCode.isGlobalReference(node) === true
  ) {
    return true;
  }
  if (
    !("getScope" in sourceCode) ||
    typeof sourceCode.getScope !== "function"
  ) {
    return false;
  }
  const binding = bindingFromScope(sourceCode.getScope(node), node.name);
  return binding === null || !bindingHasDefinitions(binding);
};
const stableAliasInitializer = (context, identifier) => {
  const variable = scopeVariableForReference(context, identifier);
  if (
    variable === null ||
    variable.references.some(
      (reference) =>
        reference.init !== true &&
        typeof reference.isWrite === "function" &&
        reference.isWrite(),
    )
  ) {
    return null;
  }
  for (const definition of variable.defs) {
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
    return definition.node.init;
  }
  return null;
};
const browserGlobalKind = (context, node, visited = new Set()) => {
  const expression = unwrapExpression(node);
  if (expression === null) {
    return null;
  }
  if (isIdentifier(expression)) {
    if (
      (expression.name === "window" ||
        expression.name === "globalThis" ||
        expression.name === "self") &&
      isGlobalReference(context, expression)
    ) {
      return expression.name;
    }
    const variable = scopeVariableForReference(context, expression);
    if (variable === null || visited.has(variable)) {
      return null;
    }
    visited.add(variable);
    return browserGlobalKind(
      context,
      stableAliasInitializer(context, expression),
      visited,
    );
  }
  if (
    expression.type !== "MemberExpression" ||
    staticMemberName(expression) !== "window"
  ) {
    return null;
  }
  return browserGlobalKind(context, expression.object, visited) === null
    ? null
    : "window";
};
const isBrowserOpenCallee = (context, callee) => {
  const unwrappedCallee = unwrapExpression(callee);
  if (isIdentifier(unwrappedCallee, "open")) {
    return isGlobalReference(context, unwrappedCallee);
  }
  if (
    !unwrappedCallee ||
    unwrappedCallee.type !== "MemberExpression" ||
    staticMemberName(unwrappedCallee) !== "open"
  ) {
    return false;
  }
  return browserGlobalKind(context, memberObject(unwrappedCallee)) !== null;
};
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
      requireSafeWindowOpen:
        "Pass noopener,noreferrer in the third argument to window.open() so the browser isolates the opener.",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};

    return {
      CallExpression(node) {
        if (!isBrowserOpenCallee(context, node.callee)) {
          return;
        }
        const features = node.arguments[2];
        if (
          features?.type === "Literal" &&
          typeof features.value === "string" &&
          /(?:^|,)\s*noopener(?:\s|,|$)/u.test(features.value) &&
          /(?:^|,)\s*noreferrer(?:\s|,|$)/u.test(features.value)
        ) {
          return;
        }
        context.report({
          node,
          messageId: "requireSafeWindowOpen",
        });
      },
    };
  },
};
