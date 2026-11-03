import { isRuleFile, scopeProperties } from "../shared/rule-scope.js";
import { getPropertyName, isIdentifier, unwrapExpression } from "./ast.js";

const rootIdentifier = (node) => {
  const unwrapped = unwrapExpression(node);
  if (!unwrapped || typeof unwrapped.type !== "string") {
    return null;
  }
  if (unwrapped.type === "Identifier") {
    return unwrapped;
  }
  if (unwrapped.type === "MemberExpression") {
    return rootIdentifier(unwrapped.object);
  }
  if (unwrapped.type === "CallExpression") {
    return rootIdentifier(unwrapped.callee);
  }
  return null;
};
const isAllowedCompositionSpread = (node) => {
  const unwrapped = unwrapExpression(node);
  if (!unwrapped || typeof unwrapped.type !== "string") {
    return false;
  }
  if (unwrapped.type === "MemberExpression") {
    const root = rootIdentifier(unwrapped.object);
    return isIdentifier(root) && root.name.endsWith("Keys");
  }
  if (unwrapped.type === "CallExpression") {
    return isAllowedCompositionSpread(unwrapped.callee);
  }
  return false;
};
const isLeakySpread = (element) => {
  if (!element || element.type !== "SpreadElement") {
    return false;
  }
  return !isAllowedCompositionSpread(element.argument);
};
const isExplicitObjectSpread = (node) => {
  const unwrapped = unwrapExpression(node);
  if (!unwrapped || typeof unwrapped.type !== "string") {
    return false;
  }
  if (unwrapped.type === "ObjectExpression") {
    if (!Array.isArray(unwrapped.properties)) {
      return false;
    }
    return unwrapped.properties.every((property) => {
      if (property?.type === "SpreadElement") {
        return isExplicitObjectSpread(property.argument);
      }
      return property?.computed !== true;
    });
  }
  if (unwrapped.type === "LogicalExpression" && unwrapped.operator === "&&") {
    return isExplicitObjectSpread(unwrapped.right);
  }
  if (unwrapped.type === "ConditionalExpression") {
    return (
      isExplicitObjectSpread(unwrapped.consequent) &&
      isExplicitObjectSpread(unwrapped.alternate)
    );
  }
  return false;
};
const isLeakyObjectSpread = (property) =>
  property?.type === "SpreadElement" &&
  !isExplicitObjectSpread(property.argument);
const startsBefore = (candidate, node) => {
  const candidateStart = candidate?.loc?.start;
  const nodeStart = node?.loc?.start;
  if (
    typeof candidateStart?.line !== "number" ||
    typeof candidateStart.column !== "number" ||
    typeof nodeStart?.line !== "number" ||
    typeof nodeStart.column !== "number"
  ) {
    return true;
  }
  if (candidateStart.line !== nodeStart.line) {
    return candidateStart.line < nodeStart.line;
  }
  return candidateStart.column < nodeStart.column;
};
const findConstInitializer = (scopeNode, identifier) => {
  if (!Array.isArray(scopeNode.body)) {
    return null;
  }
  for (const statement of scopeNode.body) {
    if (!startsBefore(statement, identifier)) {
      continue;
    }
    if (
      statement?.type !== "VariableDeclaration" ||
      statement.kind !== "const"
    ) {
      continue;
    }
    for (const declarator of statement.declarations ?? []) {
      if (isIdentifier(declarator.id, identifier.name)) {
        return declarator.init ?? null;
      }
    }
  }
  return null;
};
const findVisibleConstInitializer = (identifier) => {
  let current = identifier.parent;
  while (current) {
    if (current.type === "BlockStatement" || current.type === "Program") {
      const initializer = findConstInitializer(current, identifier);
      if (initializer !== null) {
        return initializer;
      }
    }
    current = current.parent;
  }
  return null;
};
const parentAfterExpressionWrappers = (node) => {
  let current = node.parent;
  while (
    current?.type === "TSAsExpression" ||
    current?.type === "TSSatisfiesExpression"
  ) {
    current = current.parent;
  }
  return current;
};
const isInsideKeysFactory = (objectExpression) => {
  let current = objectExpression;
  while (current?.type === "ObjectExpression") {
    const owner = parentAfterExpressionWrappers(current);
    if (owner?.type === "VariableDeclarator") {
      const id = owner.id;
      return id?.type === "Identifier" && id.name.endsWith("Keys");
    }
    if (owner?.type !== "Property") {
      return false;
    }
    const parentExpression = owner.parent;
    if (parentExpression?.type !== "ObjectExpression") {
      return false;
    }
    current = parentExpression;
  }
  return false;
};
const isQueryKeyFactoryReturn = (arrayNode) => {
  let current = parentAfterExpressionWrappers(arrayNode);
  if (current?.type === "ConditionalExpression") {
    current = parentAfterExpressionWrappers(current);
  }
  if (current?.type === "ReturnStatement") {
    current = current.parent;
    while (current && current.type === "BlockStatement") {
      current = current.parent;
    }
  }
  if (current?.type !== "ArrowFunctionExpression") {
    return false;
  }
  const property = current.parent;
  if (property?.type !== "Property") {
    return false;
  }
  const objectExpression = property.parent;
  if (objectExpression?.type !== "ObjectExpression") {
    return false;
  }
  return isInsideKeysFactory(objectExpression);
};
class QueryKeySpreadAnalysis {
  constructor(context) {
    this.context = context;
    this.swrKeyHooks = new Set(["useSWR", "useSWRImmutable", "useSWRMutation"]);
  }
  reportLeakySpreads = (node) => {
    const expression = unwrapExpression(node);
    if (!expression || typeof expression.type !== "string") {
      return;
    }
    if (
      expression.type === "LogicalExpression" &&
      expression.operator === "&&"
    ) {
      this.reportLeakySpreads(expression.right);
      return;
    }
    if (expression.type === "ConditionalExpression") {
      this.reportLeakySpreads(expression.consequent);
      this.reportLeakySpreads(expression.alternate);
      return;
    }
    if (expression.type === "ArrayExpression") {
      const elements = Array.isArray(expression.elements)
        ? expression.elements
        : [];
      for (const element of elements) {
        if (isLeakySpread(element)) {
          this.context.report({
            node: element,
            messageId: "spreadInputInQueryKey",
          });
          continue;
        }
        this.reportLeakySpreads(element);
      }
      return;
    }
    if (expression.type !== "ObjectExpression") {
      return;
    }
    this.reportObjectSpreads(expression);
  };

  reportObjectSpreads = (expression) => {
    const properties = Array.isArray(expression.properties)
      ? expression.properties
      : [];
    for (const property of properties) {
      if (isLeakyObjectSpread(property)) {
        this.context.report({
          node: property,
          messageId: "spreadInputInQueryKey",
        });
        continue;
      }
      if (property?.type === "SpreadElement") {
        this.reportLeakySpreads(property.argument);
        continue;
      }
      if (property?.type === "Property") {
        this.reportLeakySpreads(property.value);
      }
    }
  };

  onProperty = (node) => {
    if (getPropertyName(node.key) !== "queryKey") {
      return;
    }
    const expression = unwrapExpression(node.value);
    if (isIdentifier(expression)) {
      this.reportLeakySpreads(findVisibleConstInitializer(expression));
      return;
    }
    this.reportLeakySpreads(expression);
  };

  onArrayExpression = (node) => {
    if (!isQueryKeyFactoryReturn(node)) {
      return;
    }
    this.reportLeakySpreads(node);
  };

  onCallExpression = (node) => {
    const callee = unwrapExpression(node.callee);
    if (!isIdentifier(callee) || !this.swrKeyHooks.has(callee.name)) {
      return;
    }
    const keyArg = unwrapExpression(node.arguments?.at(0));
    if (isIdentifier(keyArg)) {
      this.reportLeakySpreads(findVisibleConstInitializer(keyArg));
      return;
    }
    this.reportLeakySpreads(keyArg);
  };

  listeners() {
    return {
      Property: this.onProperty,
      ArrayExpression: this.onArrayExpression,
      CallExpression: this.onCallExpression,
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
      spreadInputInQueryKey:
        "Do not spread a bare input object into a query key. " +
        "Spreading leaks every property of the source into the " +
        "cache identity (spurious refetches, stale reads, unbounded " +
        "cache growth). Spread a `*Keys` composition call " +
        "(`...entitiesKeys.all(ws)`) and list concrete cache-identity " +
        "fields explicitly instead.",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    return new QueryKeySpreadAnalysis(context).listeners();
  },
};
