import { isRuleFile, scopeProperties } from "./scope.js";
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
const importedPathBinding = (variable) => {
  if (variable === null) {
    return null;
  }
  for (const definition of variable.defs) {
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
const stableInitializer = (variable) => {
  for (const definition of variable.defs) {
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
      variable.references.some(
        (reference) =>
          reference.init !== true && reference.isWrite?.() === true,
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

    const resolveVariable = (identifier) => {
      let scope = context.sourceCode.getScope(identifier);
      while (scope !== null) {
        const variable = scope.set.get(identifier.name);
        if (variable !== undefined) {
          return variable;
        }
        scope = scope.upper;
      }
      return null;
    };
    const resolveStableExpression = (node, visited = new Set()) => {
      const expression = unwrapExpression(node);
      if (!isEstreeIdentifier(expression)) {
        return expression;
      }
      const variable = resolveVariable(expression);
      if (variable === null || visited.has(variable)) {
        return expression;
      }
      const initializer = stableInitializer(variable);
      if (initializer === null) {
        return expression;
      }
      visited.add(variable);
      return resolveStableExpression(initializer, visited);
    };
    const nodePathApiParts = (node) => {
      const member = staticMemberParts(node);
      if (member === null || !isEstreeIdentifier(member.root)) {
        return null;
      }
      const imported = importedPathBinding(resolveVariable(member.root));
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
    const isNodePathApi = (node, api) => {
      const parts = nodePathApiParts(node);
      if (parts === null || parts.at(-1) !== api) {
        return false;
      }
      return (
        parts.length === 1 ||
        (parts.length === 2 && PATH_PLATFORMS.has(parts[0] ?? ""))
      );
    };
    const getPathValueCall = (node) => {
      const expression = resolveStableExpression(node);
      if (
        expression?.type !== "CallExpression" ||
        !isAstNode(expression.callee)
      ) {
        return null;
      }
      const parts = nodePathApiParts(expression.callee);
      const api = parts?.at(-1);
      if (
        api === undefined ||
        !PATH_VALUE_APIS.has(api) ||
        !isNodePathApi(expression.callee, api)
      ) {
        return null;
      }
      return expression;
    };
    const sameStableExpression = (left, right) => {
      const stableLeft = resolveStableExpression(left);
      const stableRight = resolveStableExpression(right);
      if (stableLeft === null || stableRight === null) {
        return false;
      }
      if (stableLeft === stableRight) {
        return true;
      }
      if (isEstreeIdentifier(stableLeft) && isEstreeIdentifier(stableRight)) {
        const leftVariable = resolveVariable(stableLeft);
        return (
          leftVariable !== null && leftVariable === resolveVariable(stableRight)
        );
      }
      return (
        isStringLiteral(stableLeft) &&
        isStringLiteral(stableRight) &&
        stableLeft.value === stableRight.value
      );
    };
    const isZeroStartPosition = (node) => {
      const expression = resolveStableExpression(node);
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
    const isPathSeparator = (node) => {
      const expression = resolveStableExpression(node);
      return (
        (isStringLiteral(expression) &&
          PATH_SEPARATORS.has(expression.value)) ||
        isNodePathApi(expression, "sep")
      );
    };
    const hasPathSeparatorSuffix = (node) => {
      const expression = resolveStableExpression(node);
      if (isStringLiteral(expression)) {
        return [...PATH_SEPARATORS].some((separator) =>
          expression.value.endsWith(separator),
        );
      }
      if (expression?.type === "ConditionalExpression") {
        if (
          hasPathSeparatorSuffix(expression.consequent) &&
          hasPathSeparatorSuffix(expression.alternate)
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
          !isPathSeparator(test.arguments.at(0)) ||
          !sameStableExpression(test.callee.object, expression.consequent)
        ) {
          return false;
        }
        return hasPathSeparatorSuffix(expression.alternate);
      }
      if (
        expression?.type === "BinaryExpression" &&
        expression.operator === "+"
      ) {
        return isPathSeparator(expression.right);
      }
      if (expression?.type !== "TemplateLiteral") {
        return false;
      }
      const quasis = Array.isArray(expression.quasis) ? expression.quasis : [];
      const trailingQuasi = quasis.at(-1);
      if (!isAstNode(trailingQuasi)) {
        return false;
      }
      const trailingText =
        trailingQuasi.value.cooked ?? trailingQuasi.value.raw;
      if (
        [...PATH_SEPARATORS].some((separator) =>
          trailingText.endsWith(separator),
        )
      ) {
        return true;
      }
      const expressions = Array.isArray(expression.expressions)
        ? expression.expressions
        : [];
      return trailingText === "" && isPathSeparator(expressions.at(-1));
    };
    return {
      CallExpression(node) {
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
            isZeroStartPosition(node.arguments.at(1)));
        if (!hasEquivalentStartPosition) {
          return;
        }
        const prefix = node.arguments.at(0);
        if (hasPathSeparatorSuffix(prefix)) {
          return;
        }
        const candidateCall = getPathValueCall(node.callee.object);
        if (candidateCall === null) {
          return;
        }
        context.report({ node, messageId: "noPathPrefixContainment" });
      },
    };
  },
};
