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
      getMemberPropertyName(node)
    );
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
export const isFunctionValue = (node) =>
  node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression";
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
const FIXTURE_OR_DOCS_PATTERN =
  /\.(fixture|mock|stub)\.[cm]?[jt]sx?$|(?:^|\/)(__fixtures__|__mocks__|docs|fixtures)\//;
export const isFixtureOrDocsFile = (filename) =>
  typeof filename === "string" && FIXTURE_OR_DOCS_PATTERN.test(filename);
const MIGRATION_PATTERN =
  /(?:^|\/)(?:migrations?|db\/migrations)(?:\/|$)|(?:^|\/)\d+[_-][^/]+\.[cm]?[jt]sx?$/;
export const isMigrationFile = (filename) =>
  typeof filename === "string" && MIGRATION_PATTERN.test(filename);
const DOMAIN_PATTERN = /(?:^|\/)(?:domain|model)\//;
export const isDomainFile = (filename) =>
  typeof filename === "string" && DOMAIN_PATTERN.test(filename);
