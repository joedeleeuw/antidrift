const TEST_FILENAME_PATTERN =
  /(?:\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)(?:test|tests|__tests__)(?:\/|$))/;
export const isTestFilename = (filename) =>
  typeof filename === "string" && TEST_FILENAME_PATTERN.test(filename);
export const toNode = (candidate) => {
  if (!candidate || typeof candidate !== "object") {
    return null;
  }
  const type = candidate.type;
  if (typeof type !== "string") {
    return null;
  }
  return candidate;
};
export const toNodeArray = (candidate) => {
  if (!Array.isArray(candidate)) {
    return [];
  }
  return candidate
    .map((entry) => toNode(entry))
    .filter((entry) => entry !== null);
};
export const getNode = (node, key) => toNode(node[key]);
export const getNodeArray = (node, key) => toNodeArray(node[key]);
export const getString = (candidate) =>
  typeof candidate === "string" ? candidate : null;
export const getCommentText = (candidate) => {
  const node = toNode(candidate);
  if (!node) {
    return "";
  }
  return getString(node.value) ?? "";
};
export const getIdentifierName = (candidate) => {
  const node = toNode(candidate);
  if (!node || node.type !== "Identifier") {
    return null;
  }
  return getString(node.name);
};
export const getLiteralString = (candidate) => {
  const node = toNode(candidate);
  if (!node || node.type !== "Literal") {
    return null;
  }
  return getString(node.value);
};
export const getMemberPropertyName = (candidate) => {
  const member = toNode(candidate);
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
export const getCallChain = (candidate) => {
  const node = toNode(candidate);
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
export const isFunctionExpression = (node) =>
  node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression";
export const unwrapChainExpression = (candidate) => {
  const node = toNode(candidate);
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
