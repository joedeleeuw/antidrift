import { basename } from "node:path";

const TEST_FILENAME_PATTERN =
  /(?:\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)(?:test|tests|__tests__)(?:\/|$))/;
export const isTestFilename = (filename) =>
  typeof filename === "string" && TEST_FILENAME_PATTERN.test(filename);
export const toNode = (value) => {
  if (!value || typeof value !== "object") {
    return null;
  }
  const type = value.type;
  if (typeof type !== "string") {
    return null;
  }
  return value;
};
export const toNodeArray = (value) => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => toNode(entry)).filter((entry) => entry !== null);
};
export const getNode = (node, key) => toNode(node[key]);
export const getNodeArray = (node, key) => toNodeArray(node[key]);
export const getString = (value) => (typeof value === "string" ? value : null);
export const getCommentText = (value) => {
  const node = toNode(value);
  if (!node) {
    return "";
  }
  return getString(node.value) ?? getString(node.raw) ?? "";
};
export const getIdentifierName = (value) => {
  const node = toNode(value);
  if (!node || node.type !== "Identifier") {
    return null;
  }
  return getString(node.name);
};
export const getLiteralString = (value) => {
  const node = toNode(value);
  if (!node || node.type !== "Literal") {
    return null;
  }
  return getString(node.value);
};
export const getMemberPropertyName = (value) => {
  const member = toNode(value);
  if (!member || member.type !== "MemberExpression") {
    return null;
  }
  const computed = member.computed === true;
  if (computed) {
    return getLiteralString(member.property);
  }
  return getIdentifierName(member.property);
};
const appendCallChainMember = (chain, memberName) => {
  if (!chain || !memberName) {
    return null;
  }
  return {
    rootIdentifier: chain.rootIdentifier,
    members: [...chain.members, memberName],
  };
};
export const getCallChain = (value) => {
  const node = toNode(value);
  if (!node) {
    return null;
  }
  if (node.type === "Identifier") {
    return {
      rootIdentifier: getString(node.name),
      members: [],
    };
  }
  if (node.type === "CallExpression") {
    return getCallChain(node.callee);
  }
  if (node.type === "MemberExpression") {
    return appendCallChainMember(
      getCallChain(node.object),
      getMemberPropertyName(node),
    );
  }
  return null;
};
export const isMemberExpressionCall = (node, objectName, propertyNameSet) => {
  if (node.type !== "CallExpression") {
    return false;
  }
  const callee = toNode(node.callee);
  if (!callee || callee.type !== "MemberExpression") {
    return false;
  }
  const objectNameValue = getIdentifierName(callee.object);
  if (objectNameValue !== objectName) {
    return false;
  }
  const propertyName = getMemberPropertyName(callee);
  return propertyName !== null && propertyNameSet.has(propertyName);
};
export const isEffectCallExpression = (value) => {
  const node = toNode(value);
  if (!node || node.type !== "CallExpression") {
    return false;
  }
  const callChain = getCallChain(node);
  if (!callChain) {
    return false;
  }
  return callChain.rootIdentifier === "Effect";
};
export const extractFunctionName = (node) => {
  if (node.type === "FunctionDeclaration") {
    return getIdentifierName(node.id);
  }
  if (node.type === "MethodDefinition") {
    return getIdentifierName(node.key) ?? getLiteralString(node.key);
  }
  if (node.type === "VariableDeclarator") {
    return getIdentifierName(node.id);
  }
  return null;
};
export const getFunctionStatements = (node) => {
  const body = getNode(node, "body");
  if (!body || body.type !== "BlockStatement") {
    return [];
  }
  return getNodeArray(body, "body");
};

export const splitWords = (value) => {
  if (value.length === 0) {
    return [];
  }
  const normalized = value
    .replace(/[-_]/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();
  if (normalized.length === 0) {
    return [];
  }
  return normalized
    .split(/\s+/)
    .map((segment) => segment.toLowerCase())
    .filter((segment) => segment.length > 0);
};
export const firstLowercaseToken = (name) => {
  const match = /^([a-z]+)/.exec(name);
  return match?.[1] ?? null;
};
export const isFunctionValue = (node) =>
  node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression";
export const isDefaultFallbackNode = (value) => {
  const node = toNode(value);
  if (!node) {
    return true;
  }
  if (node.type === "Literal") {
    return true;
  }
  if (node.type === "ObjectExpression") {
    return node.properties.every(
      (property) =>
        property.type === "Property" && isDefaultFallbackNode(property.value),
    );
  }
  if (node.type === "ArrayExpression") {
    return node.elements.every(isDefaultFallbackNode);
  }
  if (node.type === "Identifier") {
    const name = getString(node.name);
    return name === "undefined";
  }
  if (node.type === "UnaryExpression") {
    return node.operator === "void";
  }
  return false;
};
export const unwrapChainExpression = (value) => {
  const node = toNode(value);
  if (!node) {
    return null;
  }
  if (node.type !== "ChainExpression") {
    return node;
  }
  return toNode(node.expression);
};
export const isPropertyAccessLike = (value) => {
  const node = unwrapChainExpression(value);
  return node?.type === "MemberExpression";
};
export const isPrimitiveLiteralNode = (value) => {
  const node = toNode(value);
  if (!node) {
    return false;
  }
  if (node.type === "Literal") {
    return (
      typeof node.value === "string" ||
      typeof node.value === "number" ||
      typeof node.value === "boolean" ||
      node.value === null
    );
  }
  if (node.type !== "TemplateLiteral") {
    return false;
  }
  return getNodeArray(node, "expressions").length === 0;
};
export const walkAst = (node, visitor) => {
  const current = toNode(node);
  if (!current) {
    return;
  }
  visitor(current);
  for (const [key, value] of Object.entries(current)) {
    if (key === "parent" || value == null) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        walkAst(item, visitor);
      }
      continue;
    }
    if (typeof value === "object") {
      walkAst(value, visitor);
    }
  }
};
export const someNode = (node, predicate) => {
  let found = false;
  walkAst(node, (candidate) => {
    if (found) {
      return;
    }
    if (predicate(candidate)) {
      found = true;
    }
  });
  return found;
};
export const collectNodes = (node, predicate) => {
  const matches = [];
  walkAst(node, (candidate) => {
    if (predicate(candidate)) {
      matches.push(candidate);
    }
  });
  return matches;
};
export const getProgramDirectives = (node) => {
  if (node.type !== "Program") {
    return new Set();
  }
  const directives = new Set();
  for (const statement of getNodeArray(node, "body")) {
    if (statement.type !== "ExpressionStatement") {
      continue;
    }
    const directive = getLiteralString(statement.expression);
    if (!directive) {
      continue;
    }
    directives.add(directive);
  }
  return directives;
};
export const getProgramBody = (node) =>
  node.type === "Program" ? getNodeArray(node, "body") : [];
export const hasProgramDirective = (node, directive) =>
  getProgramDirectives(node).has(directive);
export const getImportSources = (node) => {
  if (node.type !== "Program") {
    return new Set();
  }
  const sources = new Set();
  for (const statement of getNodeArray(node, "body")) {
    if (statement.type !== "ImportDeclaration") {
      continue;
    }
    const source = getLiteralString(statement.source);
    if (source) {
      sources.add(source);
    }
  }
  return sources;
};
export const hasImportSource = (node, predicate) => {
  const matcher =
    typeof predicate === "string" ? (value) => value === predicate : predicate;
  for (const source of getImportSources(node)) {
    if (matcher(source)) {
      return true;
    }
  }
  return false;
};
const FIXTURE_OR_DOCS_PATTERN =
  /\.(fixture|mock|stub)\.[cm]?[jt]sx?$|(?:^|\/)(__fixtures__|__mocks__|docs|fixtures)\//;
export const isFixtureOrDocsFile = (filename) =>
  typeof filename === "string" && FIXTURE_OR_DOCS_PATTERN.test(filename);
const MIGRATION_PATTERN =
  /(?:^|\/)(?:migrations?|db\/migrations)(?:\/|$)|(?:^|\/)\d+[_-][^/]+\.[cm]?[jt]sx?$/;
export const isMigrationFile = (filename) =>
  typeof filename === "string" && MIGRATION_PATTERN.test(filename);
const COMPOSITION_ROOT_PATTERN =
  /(?:^|\/)(?:layers?|composition|bootstrap|wire|di|providers?)(?:\.[cm]?[jt]sx?$|\/)/;
export const isCompositionRootFile = (filename) =>
  typeof filename === "string" && COMPOSITION_ROOT_PATTERN.test(filename);
const DOMAIN_PATTERN = /(?:^|\/)(?:domain|model|core)\//;
export const isDomainFile = (filename) =>
  typeof filename === "string" && DOMAIN_PATTERN.test(filename);
const LAYER_PATTERNS = [
  ["ui", /(?:^|\/)(?:ui|components|pages|views)\//],
  ["app", /(?:^|\/)(?:app|application|services)\//],
  ["domain", /(?:^|\/)(?:domain|model|core)\//],
  ["infra", /(?:^|\/)(?:infra|infrastructure|adapters|external)\//],
];
const LAYER_ORDER = {
  ui: 0,
  app: 1,
  domain: 2,
  infra: 3,
};
export const getArchitecturalLayer = (filename) => {
  if (!filename) {
    return null;
  }
  for (const [layer, pattern] of LAYER_PATTERNS) {
    if (pattern.test(filename)) {
      return layer;
    }
  }
  return null;
};
export const isLayerViolation = (fromLayer, toLayer) =>
  LAYER_ORDER[fromLayer] > LAYER_ORDER[toLayer];
export const serializeAstForComparison = (node) => {
  const current = toNode(node);
  if (!current) {
    return "";
  }
  const parts = [current.type];
  if (current.type === "Literal" && current.value !== undefined) {
    parts.push(String(current.value));
  }
  if (current.type === "Identifier" && typeof current.name === "string") {
    parts.push(current.name);
  }
  if (typeof current.operator === "string") {
    parts.push(current.operator);
  }
  for (const [key, value] of Object.entries(current)) {
    if (
      key === "type" ||
      key === "parent" ||
      key === "start" ||
      key === "end" ||
      key === "loc" ||
      key === "range" ||
      key === "raw" ||
      key === "comments" ||
      key === "leadingComments" ||
      key === "trailingComments" ||
      value == null
    ) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        parts.push(serializeAstForComparison(item));
      }
    } else if (typeof value === "object") {
      parts.push(serializeAstForComparison(value));
    }
  }
  return parts.join("|");
};
const LOOP_NODE_TYPES = new Set([
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "WhileStatement",
  "DoWhileStatement",
]);
export const isLoopNode = (value) => {
  const node = toNode(value);
  if (!node) {
    return false;
  }
  return LOOP_NODE_TYPES.has(node.type);
};
const APP_ROUTER_PATTERN = /(?:^|\/)app\//;
const APP_ROUTER_ROOT_FILE_PATTERN =
  /(?:^|\/)app\/(?:.*\/)?(?:page|layout|template|default|loading)\.[cm]?[jt]sx?$/;
export const isAppRouterFile = (filename) =>
  typeof filename === "string" && APP_ROUTER_PATTERN.test(filename);
export const isAppRouterRootFile = (filename) =>
  typeof filename === "string" && APP_ROUTER_ROOT_FILE_PATTERN.test(filename);
export const getFilenameBase = (filename) =>
  typeof filename === "string" ? basename(filename) : null;

export function walkLocalAst(node, visitor) {
  if (!node || typeof node !== "object" || typeof node.type !== "string") {
    return;
  }
  if (
    [
      "FunctionDeclaration",
      "FunctionExpression",
      "ArrowFunctionExpression",
    ].includes(node.type)
  ) {
    return;
  }
  visitor(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent") continue;
    for (const child of Array.isArray(value) ? value : [value]) {
      walkLocalAst(child, visitor);
    }
  }
}
