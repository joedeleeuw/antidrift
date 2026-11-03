import { isRuleFile, scopeProperties } from "../shared/rule-scope.js";
import { findVariable } from "../shared/scope.js";
import {
  getImportedName,
  getPropertyName,
  isAstNode,
  isIdentifier,
  isStringLiteral,
} from "./ast.js";

const PATH_MODULES = new Set(["node:path", "path"]);
const PATH_VALUE_APIS = new Set(["dirname", "join", "normalize", "resolve"]);
const PATH_PLATFORMS = new Set(["posix", "win32"]);
const PATH_SEPARATORS = new Set(["/", "\\"]);
const WRAPPER_TYPES = new Set([
  "ChainExpression",
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
]);
const unwrapExpression = (node) => {
  let current = isAstNode(node) ? node : null;
  while (current !== null && WRAPPER_TYPES.has(current.type)) {
    current = isAstNode(current.expression) ? current.expression : null;
  }
  return current;
};
const isEstreeIdentifier = (node) =>
  isIdentifier(node) && Array.isArray(node.range);
const importedPathBinding = (binding) => {
  if (binding === null) {
    return null;
  }
  for (const definition of binding.defs) {
    if (
      definition.type !== "ImportBinding" ||
      !isAstNode(definition.node) ||
      !isAstNode(definition.parent) ||
      definition.parent.type !== "ImportDeclaration" ||
      !isStringLiteral(definition.parent.source) ||
      !PATH_MODULES.has(definition.parent.source.value)
    ) {
      continue;
    }
    return {
      importedName: getImportedName(definition.node),
      type: definition.node.type,
    };
  }
  return null;
};
const stableInitializer = (binding) => {
  for (const definition of binding.defs) {
    if (
      definition.type !== "Variable" ||
      !isAstNode(definition.node) ||
      definition.node.type !== "VariableDeclarator" ||
      !isAstNode(definition.parent) ||
      definition.parent.type !== "VariableDeclaration"
    ) {
      continue;
    }
    if (
      definition.parent.kind !== "const" &&
      binding.references.some(
        (reference) => reference.init !== true && reference.isWrite?.() === true
      )
    ) {
      return null;
    }
    return unwrapExpression(definition.node.init);
  }
  return null;
};
const staticMemberParts = (node) => {
  const expression = unwrapExpression(node);
  if (expression === null) {
    return null;
  }
  if (expression.type !== "MemberExpression") {
    return { parts: [], root: expression };
  }
  const property = getPropertyName(expression.property);
  if (property === null) {
    return null;
  }
  const parent = staticMemberParts(expression.object);
  if (parent === null) {
    return null;
  }
  parent.parts.push(property);
  return parent;
};
class PathContainment {
  constructor(context) {
    this.context = context;
  }
  resolveStableExpression = (node, visited = new Set()) => {
    const expression = unwrapExpression(node);
    if (!isEstreeIdentifier(expression)) {
      return expression;
    }
    const binding = findVariable(this.context.sourceCode, expression);
    if (binding === null || visited.has(binding)) {
      return expression;
    }
    const initializer = stableInitializer(binding);
    if (initializer === null) {
      return expression;
    }
    visited.add(binding);
    return this.resolveStableExpression(initializer, visited);
  };

  nodePathApiParts = (node) => {
    const member = staticMemberParts(node);
    if (member === null || !isEstreeIdentifier(member.root)) {
      return null;
    }
    const imported = importedPathBinding(
      findVariable(this.context.sourceCode, member.root)
    );
    if (imported === null) {
      return null;
    }
    if (
      imported.type === "ImportDefaultSpecifier" ||
      imported.type === "ImportNamespaceSpecifier"
    ) {
      return member.parts;
    }
    if (imported.importedName === null) {
      return null;
    }
    return [imported.importedName, ...member.parts];
  };

  isNodePathApi = (node, api) => {
    const parts = this.nodePathApiParts(node);
    if (parts === null || parts.at(-1) !== api) {
      return false;
    }
    return (
      parts.length === 1 ||
      (parts.length === 2 && PATH_PLATFORMS.has(parts[0] ?? ""))
    );
  };

  getPathValueCall = (node) => {
    const expression = this.resolveStableExpression(node);
    if (
      expression?.type !== "CallExpression" ||
      !isAstNode(expression.callee)
    ) {
      return null;
    }
    const parts = this.nodePathApiParts(expression.callee);
    const api = parts?.at(-1);
    if (
      api === undefined ||
      !PATH_VALUE_APIS.has(api) ||
      !this.isNodePathApi(expression.callee, api)
    ) {
      return null;
    }
    return expression;
  };

  sameStableExpression = (left, right) => {
    const stableLeft = this.resolveStableExpression(left);
    const stableRight = this.resolveStableExpression(right);
    if (stableLeft === null || stableRight === null) {
      return false;
    }
    if (stableLeft === stableRight) {
      return true;
    }
    if (isEstreeIdentifier(stableLeft) && isEstreeIdentifier(stableRight)) {
      const leftVariable = findVariable(this.context.sourceCode, stableLeft);
      return (
        leftVariable !== null &&
        leftVariable === findVariable(this.context.sourceCode, stableRight)
      );
    }
    return (
      isStringLiteral(stableLeft) &&
      isStringLiteral(stableRight) &&
      stableLeft.value === stableRight.value
    );
  };

  isZeroStartPosition = (node) => {
    const expression = this.resolveStableExpression(node);
    if (expression?.type === "Literal") {
      return expression.value === 0;
    }
    if (
      expression?.type !== "UnaryExpression" ||
      (expression.operator !== "+" && expression.operator !== "-")
    ) {
      return false;
    }
    const argument = unwrapExpression(expression.argument);
    return argument?.type === "Literal" && argument.value === 0;
  };

  isPathSeparator = (node) => {
    const expression = this.resolveStableExpression(node);
    return (
      (isStringLiteral(expression) && PATH_SEPARATORS.has(expression.value)) ||
      this.isNodePathApi(expression, "sep")
    );
  };

  hasConditionalSeparatorSuffix = (expression) => {
    if (
      this.hasPathSeparatorSuffix(expression.consequent) &&
      this.hasPathSeparatorSuffix(expression.alternate)
    ) {
      return true;
    }
    const test = unwrapExpression(expression.test);
    if (
      test?.type !== "CallExpression" ||
      !isAstNode(test.callee) ||
      test.callee.type !== "MemberExpression" ||
      getPropertyName(test.callee.property) !== "endsWith" ||
      test.arguments.length !== 1 ||
      !this.isPathSeparator(test.arguments.at(0)) ||
      !this.sameStableExpression(test.callee.object, expression.consequent)
    ) {
      return false;
    }
    return this.hasPathSeparatorSuffix(expression.alternate);
  };

  hasPathSeparatorSuffix = (node) => {
    const expression = this.resolveStableExpression(node);
    if (isStringLiteral(expression)) {
      return [...PATH_SEPARATORS].some((separator) =>
        expression.value.endsWith(separator)
      );
    }
    if (expression?.type === "ConditionalExpression") {
      return this.hasConditionalSeparatorSuffix(expression);
    }
    if (
      expression?.type === "BinaryExpression" &&
      expression.operator === "+"
    ) {
      return this.isPathSeparator(expression.right);
    }
    if (expression?.type !== "TemplateLiteral") {
      return false;
    }
    const quasis = Array.isArray(expression.quasis) ? expression.quasis : [];
    const trailingQuasi = quasis.at(-1);
    if (!isAstNode(trailingQuasi)) {
      return false;
    }
    const trailingText = trailingQuasi.value.cooked ?? trailingQuasi.value.raw;
    if (
      [...PATH_SEPARATORS].some((separator) => trailingText.endsWith(separator))
    ) {
      return true;
    }
    const expressions = Array.isArray(expression.expressions)
      ? expression.expressions
      : [];
    return trailingText === "" && this.isPathSeparator(expressions.at(-1));
  };

  visitCallExpression = (node) => {
    if (
      !isAstNode(node.callee) ||
      node.callee.type !== "MemberExpression" ||
      getPropertyName(node.callee.property) !== "startsWith" ||
      !Array.isArray(node.arguments)
    ) {
      return;
    }
    const hasEquivalentStartPosition =
      node.arguments.length === 1 ||
      (node.arguments.length === 2 &&
        this.isZeroStartPosition(node.arguments.at(1)));
    if (!hasEquivalentStartPosition) {
      return;
    }
    const prefix = node.arguments.at(0);
    if (this.hasPathSeparatorSuffix(prefix)) {
      return;
    }
    const candidateCall = this.getPathValueCall(node.callee.object);
    if (candidateCall === null) {
      return;
    }
    this.context.report({ node, messageId: "noPathPrefixContainment" });
  };
  listeners() {
    return {
      CallExpression: this.visitCallExpression,
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
      noPathPrefixContainment:
        "A bare path prefix also accepts sibling paths such as " +
        "'<root>-backup'. Use path.relative() with '..' and absolute-path " +
        "checks, or an approved boundary-aware containment helper.",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    return new PathContainment(context).listeners();
  },
};
