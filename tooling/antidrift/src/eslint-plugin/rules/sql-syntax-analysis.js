import ts from "typescript";

import { unwrapExpression } from "../../semantic-adapters/local-ast-rules.mjs";
import { isSqlIdentifierTokenValue } from "../../semantic-adapters/sql.mjs";

const sqlPattern =
  /\b(?:SELECT\b[\s\S]{0,200}?\bFROM\b|INSERT\s+INTO\b|UPDATE\s+[\w."`]+\s+SET\b|DELETE\s+FROM\b|DROP\s+TABLE\b)/iu;
const sqlSentencePattern =
  /\b(?:SELECT\b[\s\S]*?\bFROM\b|INSERT\s+INTO\b|UPDATE\b[\s\S]*?\bSET\b|DELETE\s+FROM\b|DROP\s+TABLE\b)/iu;
export function containsSqlPrefix(value) {
  return sqlPattern.test(value);
}
export function containsSqlStatement(value) {
  return containsSqlPrefix(value) || sqlSentencePattern.test(value);
}
export function templateText(node) {
  return node.quasis
    .map((quasi) => quasi.value.cooked ?? quasi.value.raw ?? "")
    .join(" ");
}
export function staticStringValue(node) {
  if (node?.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
    return templateText(node);
  }
  return null;
}
export function singleReturnExpression(node) {
  if (!node) {
    return null;
  }
  if (
    node.type === "ArrowFunctionExpression" &&
    node.body?.type !== "BlockStatement"
  ) {
    return node.body;
  }
  if (node.body?.type !== "BlockStatement" || node.body.body.length !== 1) {
    return null;
  }
  const statement = node.body.body[0];
  return statement?.type === "ReturnStatement" ? statement.argument : null;
}
function isEscapedReplaceCall(node, paramName, quote) {
  if (node?.type !== "CallExpression") {
    return false;
  }
  const callee = node.callee;
  if (callee?.type !== "MemberExpression" || callee.computed) {
    return false;
  }
  if (
    callee.object?.type !== "Identifier" ||
    callee.object.name !== paramName
  ) {
    return false;
  }
  if (
    callee.property?.type !== "Identifier" ||
    callee.property.name !== "replace"
  ) {
    return false;
  }
  const [pattern, replacement] = node.arguments;
  const patternMatches =
    pattern?.type === "Literal" &&
    ((pattern.regex &&
      pattern.regex.pattern === quote &&
      pattern.regex.flags.includes("g")) ||
      pattern.value === quote);
  return (
    patternMatches && staticStringValue(replacement) === `${quote}${quote}`
  );
}
function sqlEscaperKindFromReturnExpression(node, paramName) {
  if (node?.type !== "TemplateLiteral" || node.expressions.length !== 1) {
    return null;
  }
  const before =
    node.quasis[0]?.value.cooked ?? node.quasis[0]?.value.raw ?? "";
  const after = node.quasis[1]?.value.cooked ?? node.quasis[1]?.value.raw ?? "";
  if (
    before === '"' &&
    after === '"' &&
    isEscapedReplaceCall(node.expressions[0], paramName, '"')
  ) {
    return "identifier";
  }
  if (
    before === "'" &&
    after === "'" &&
    isEscapedReplaceCall(node.expressions[0], paramName, "'")
  ) {
    return "string";
  }
  return null;
}
export function sqlEscaperFunctionKind(node) {
  if (
    node?.type !== "FunctionDeclaration" &&
    node?.type !== "FunctionExpression" &&
    node?.type !== "ArrowFunctionExpression"
  ) {
    return null;
  }
  const param = node.params?.[0];
  if (node.params.length !== 1 || param?.type !== "Identifier") {
    return null;
  }
  return sqlEscaperKindFromReturnExpression(
    singleReturnExpression(node),
    param.name,
  );
}
function tsStaticStringValue(node) {
  if (!node) {
    return null;
  }
  if (
    ts.isStringLiteralLike(node) ||
    ts.isNoSubstitutionTemplateLiteral(node)
  ) {
    return node.text;
  }
  return null;
}
function tsSingleReturnExpression(node) {
  if (!node?.body) {
    return null;
  }
  if (!ts.isBlock(node.body)) {
    return node.body;
  }
  if (node.body.statements.length !== 1) {
    return null;
  }
  const statement = node.body.statements[0];
  return ts.isReturnStatement(statement)
    ? (statement.expression ?? null)
    : null;
}
function tsTemplateParts(node) {
  if (!node || !ts.isTemplateExpression(node)) {
    return null;
  }
  return {
    expressions: node.templateSpans.map((span) => span.expression),
    parts: [
      node.head.text,
      ...node.templateSpans.map((span) => span.literal.text),
    ],
  };
}
function tsRegexMatchesGlobalQuote(node, quote) {
  if (!ts.isRegularExpressionLiteral(node)) {
    return false;
  }
  const text = node.getText();
  if (!text.endsWith("g")) {
    return false;
  }
  return text === `/${quote}/g`;
}
function tsEscapedReplaceCall(node, paramName, quote) {
  if (!ts.isCallExpression(node)) {
    return false;
  }
  if (!ts.isPropertyAccessExpression(node.expression)) {
    return false;
  }
  const method = node.expression.name.text;
  if (method !== "replace" && method !== "replaceAll") {
    return false;
  }
  const receiver = node.expression.expression;
  let receiverRoot = null;
  if (ts.isIdentifier(receiver)) {
    receiverRoot = receiver;
  } else if (
    ts.isPropertyAccessExpression(receiver) &&
    ts.isIdentifier(receiver.expression)
  ) {
    receiverRoot = receiver.expression;
  }
  if (receiverRoot?.text !== paramName) {
    return false;
  }
  const [pattern, replacement] = node.arguments;
  const patternMatches =
    method === "replaceAll"
      ? tsStaticStringValue(pattern) === quote
      : tsRegexMatchesGlobalQuote(pattern, quote);
  return (
    patternMatches && tsStaticStringValue(replacement) === `${quote}${quote}`
  );
}
function tsTemplateSqlEscaperKind(node, paramName) {
  const template = tsTemplateParts(node);
  if (!template || template.expressions.length === 0) {
    return null;
  }
  const skeleton = template.parts.join("A");
  const isIdentifierSkeleton = /^(?:"A"|`A`)(?:\.(?:"A"|`A`))*$/u.test(
    skeleton,
  );
  const isStringSkeleton = skeleton === "'A'";
  if (!isIdentifierSkeleton && !isStringSkeleton) {
    return null;
  }
  const expectedQuotes = template.expressions.map((_, index) => {
    const before = template.parts[index];
    const after = template.parts[index + 1];
    const quote = before.at(-1);
    return quote && quote === after?.[0] ? quote : null;
  });
  if (
    expectedQuotes.some(
      (quote) => quote !== '"' && quote !== "'" && quote !== "`",
    )
  ) {
    return null;
  }
  if (
    !template.expressions.every((expression, index) =>
      tsEscapedReplaceCall(expression, paramName, expectedQuotes[index]),
    )
  ) {
    return null;
  }
  return isStringSkeleton ? "string" : "identifier";
}
export function tsSqlEscaperDeclarationKind(node) {
  if (!node) {
    return null;
  }
  let fn = null;
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node)
  ) {
    fn = node;
  } else if (
    ts.isVariableDeclaration(node) &&
    node.initializer &&
    (ts.isFunctionExpression(node.initializer) ||
      ts.isArrowFunction(node.initializer))
  ) {
    fn = node.initializer;
  }
  if (!fn || fn.parameters.length !== 1) {
    return null;
  }
  const param = fn.parameters[0];
  if (!ts.isIdentifier(param.name)) {
    return null;
  }
  return tsTemplateSqlEscaperKind(
    tsSingleReturnExpression(fn),
    param.name.text,
  );
}
function hasOpenSqlQuote(value, quote) {
  let open = false;
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] !== quote) {
      continue;
    }
    if (value[i + 1] === quote) {
      i += 1;
      continue;
    }
    open = !open;
  }
  return open;
}
export function isUnquotedSqlInterpolation(before, after) {
  if (
    hasOpenSqlQuote(before, "'") ||
    hasOpenSqlQuote(before, '"') ||
    hasOpenSqlQuote(before, "`")
  ) {
    return false;
  }
  return !/^\s*['"`]/u.test(after);
}
export function intersectPropertySets(left, right) {
  if (!left) {
    return new Set(right);
  }
  return new Set([...left].filter((key) => right.has(key)));
}
export function collectReturnArguments(node, out) {
  if (!node) {
    return;
  }
  if (node.type === "ReturnStatement") {
    out.push(node.argument);
    return;
  }
  if (node.type === "BlockStatement") {
    for (const statement of node.body ?? []) {
      collectReturnArguments(statement, out);
    }
    return;
  }
  if (node.type === "IfStatement") {
    collectReturnArguments(node.consequent, out);
    collectReturnArguments(node.alternate, out);
  }
}
function isStaticStringCallback(node) {
  if (
    node?.type !== "ArrowFunctionExpression" &&
    node?.type !== "FunctionExpression"
  ) {
    return false;
  }
  return staticStringValue(node.body) !== null;
}
export function isStaticFragmentMapJoin(node) {
  if (node?.type !== "CallExpression") {
    return false;
  }
  const join = node.callee;
  if (
    join?.type !== "MemberExpression" ||
    join.computed ||
    join.property?.type !== "Identifier" ||
    join.property.name !== "join"
  ) {
    return false;
  }
  const separator = node.arguments[0]
    ? staticStringValue(node.arguments[0])
    : ",";
  if (!isAllowedSqlFragmentJoinSeparator(separator)) {
    return false;
  }
  const mapCall = join.object;
  if (mapCall?.type !== "CallExpression") {
    return false;
  }
  const map = mapCall.callee;
  return (
    map?.type === "MemberExpression" &&
    !map.computed &&
    map.property?.type === "Identifier" &&
    map.property.name === "map" &&
    isStaticStringCallback(mapCall.arguments[0])
  );
}
function isIndexArithmeticExpression(node, indexName) {
  const unwrapped = unwrapExpression(node);
  if (unwrapped?.type === "Identifier") {
    return unwrapped.name === indexName;
  }
  if (unwrapped?.type === "Literal") {
    return typeof unwrapped.value === "number";
  }
  if (
    unwrapped?.type !== "BinaryExpression" ||
    !["+", "*"].includes(unwrapped.operator)
  ) {
    return false;
  }
  return (
    isIndexArithmeticExpression(unwrapped.left, indexName) &&
    isIndexArithmeticExpression(unwrapped.right, indexName)
  );
}
function isPostgresPlaceholderTemplate(node, indexName) {
  if (node?.type !== "TemplateLiteral" || node.expressions.length === 0) {
    return false;
  }
  for (let index = 0; index < node.expressions.length; index += 1) {
    const before =
      node.quasis[index]?.value?.cooked ?? node.quasis[index]?.value?.raw ?? "";
    const after =
      node.quasis[index + 1]?.value?.cooked ??
      node.quasis[index + 1]?.value?.raw ??
      "";
    if (!before.endsWith("$") || /^\d/u.test(after)) {
      return false;
    }
    if (!isIndexArithmeticExpression(node.expressions[index], indexName)) {
      return false;
    }
  }
  return true;
}
function memberCallObject(node, methodName) {
  if (node?.type !== "CallExpression") {
    return null;
  }
  const member = node.callee;
  if (
    member?.type !== "MemberExpression" ||
    member.computed ||
    member.property?.type !== "Identifier" ||
    member.property.name !== methodName
  ) {
    return null;
  }
  return member.object;
}
export function isPlaceholderSqlFragmentMapJoin(node) {
  const mapCall = memberCallObject(node, "join");
  if (!mapCall) {
    return false;
  }
  const separator = node.arguments[0]
    ? staticStringValue(node.arguments[0])
    : ",";
  if (separator !== " OR " && separator !== " AND ") {
    return false;
  }
  if (!memberCallObject(mapCall, "map")) {
    return false;
  }
  const callback = mapCall.arguments[0];
  if (
    callback?.type !== "ArrowFunctionExpression" &&
    callback?.type !== "FunctionExpression"
  ) {
    return false;
  }
  const indexParam = callback.params?.[1];
  if (indexParam?.type !== "Identifier") {
    return false;
  }
  return isPostgresPlaceholderTemplate(
    singleReturnExpression(callback),
    indexParam.name,
  );
}
export function transparentRawSqlFragmentExpression(node) {
  if (!node) {
    return null;
  }
  if (
    [
      "TSAsExpression",
      "TSTypeAssertion",
      "TSNonNullExpression",
      "ChainExpression",
    ].includes(node.type)
  ) {
    return node.expression;
  }
  if (node.type === "UnaryExpression" || node.type === "AwaitExpression") {
    return node.argument;
  }
  return null;
}
function unsafeTrustedRawSqlCallChildren(node) {
  return [
    node.callee,
    ...node.arguments.map((argument) =>
      argument?.type === "SpreadElement" ? argument.argument : argument,
    ),
  ];
}
function unsafeTrustedRawSqlMemberChildren(node) {
  return node.computed ? [node.object, node.property] : [node.object];
}
function unsafeTrustedRawSqlPropertyChildren(property) {
  if (property.type === "SpreadElement") {
    return [property.argument];
  }
  return property.computed ? [property.key, property.value] : [property.value];
}
export function unsafeTrustedRawSqlChildren(node) {
  switch (node?.type) {
    case "ConditionalExpression":
      return [node.test, node.consequent, node.alternate];
    case "LogicalExpression":
    case "BinaryExpression":
      return [node.left, node.right];
    case "SequenceExpression":
      return node.expressions;
    case "CallExpression":
      return unsafeTrustedRawSqlCallChildren(node);
    case "MemberExpression":
      return unsafeTrustedRawSqlMemberChildren(node);
    case "ArrayExpression":
      return node.elements;
    case "ObjectExpression":
      return node.properties.flatMap(unsafeTrustedRawSqlPropertyChildren);
    case "TaggedTemplateExpression":
      return [node.tag, node.quasi];
    case "TemplateLiteral":
      return node.expressions;
    default:
      return [];
  }
}
export function isEmptyArrayExpression(node) {
  return node?.type === "ArrayExpression" && node.elements.length === 0;
}
export function isAllowedSqlFragmentJoinSeparator(value) {
  return (
    value === "," || value === ", " || value === " AND " || value === " OR "
  );
}
function sqlStringValuesFromType(typeNode) {
  if (!typeNode) {
    return null;
  }
  if (typeNode.type === "TSUnionType") {
    const values = new Set();
    for (const part of typeNode.types) {
      const partValues = sqlStringValuesFromType(part);
      if (!partValues) {
        return null;
      }
      for (const value of partValues) {
        values.add(value);
      }
    }
    return values;
  }
  if (typeNode.type !== "TSLiteralType") {
    return null;
  }
  const literal = typeNode.literal;
  return literal?.type === "Literal" && typeof literal.value === "string"
    ? new Set([literal.value])
    : null;
}
export function sqlTypePropertyValues(typeNode, propertyName) {
  if (typeNode?.type !== "TSTypeLiteral") {
    return null;
  }
  for (const member of typeNode.members ?? []) {
    if (member.type !== "TSPropertySignature") {
      continue;
    }
    const keyName = sqlPropertyKeyName(member.key);
    if (keyName === propertyName) {
      return sqlStringValuesFromType(member.typeAnnotation?.typeAnnotation);
    }
  }
  return null;
}
export function sqlPropertyKeyName(key) {
  if (key?.type === "Identifier") {
    return key.name;
  }
  if (key?.type === "Literal") {
    return String(key.value);
  }
  return "";
}
function charClassAllowsOnlySqlIdentifierChars(value, { allowDigit }) {
  let i = 0;
  while (i < value.length) {
    const char = value[i];
    const next = value[i + 1];
    const end = value[i + 2];
    if (next === "-" && end) {
      const range = `${char}-${end}`;
      if (
        range !== "a-z" &&
        range !== "A-Z" &&
        (!allowDigit || range !== "0-9")
      ) {
        return false;
      }
      i += 3;
    } else {
      const isLetter = /[A-Za-z]/u.test(char);
      const isDigit = /\d/u.test(char);
      if (!isLetter && char !== "_" && (!allowDigit || !isDigit)) {
        return false;
      }
      i += 1;
    }
  }
  return true;
}
export function isSqlIdentifierRegexLiteral(node) {
  const pattern =
    node?.type === "Literal" && node.regex ? node.regex.pattern : "";
  const match = /^\^\[([^\]]+)\]\[([^\]]+)\]\*\$$/u.exec(pattern);
  if (!match) {
    return false;
  }
  return (
    charClassAllowsOnlySqlIdentifierChars(match[1], { allowDigit: false }) &&
    charClassAllowsOnlySqlIdentifierChars(match[2], { allowDigit: true })
  );
}
export function assignedSqlIdentifierNode(node) {
  if (node.left?.type === "Identifier") {
    return node.left;
  }
  if (
    node.left?.type === "MemberExpression" &&
    node.left.object?.type === "Identifier"
  ) {
    return node.left.object;
  }
  return null;
}
export function classMemberKey(node) {
  if (node?.type !== "MemberExpression" || node.computed) {
    return null;
  }
  if (
    node.object?.type !== "ThisExpression" ||
    node.property?.type !== "Identifier"
  ) {
    return null;
  }
  return node.property.name;
}
export function enclosingClass(node) {
  let cur = node?.parent ?? null;
  while (cur) {
    if (cur.type === "ClassDeclaration" || cur.type === "ClassExpression") {
      return cur;
    }
    cur = cur.parent;
  }
  return null;
}
export function statementExits(node) {
  if (!node) {
    return false;
  }
  if (node.type === "ThrowStatement" || node.type === "ReturnStatement") {
    return true;
  }
  if (node.type === "BlockStatement") {
    return statementExits(node.body.at(-1));
  }
  if (node.type === "IfStatement") {
    return statementExits(node.consequent) && statementExits(node.alternate);
  }
  return false;
}
export function unionStringValues(left, right) {
  if (!left || !right) {
    return null;
  }
  return new Set([...left, ...right]);
}
export function variableTypeNode(variable) {
  const def = variable?.defs?.[0];
  return (
    def?.name?.typeAnnotation?.typeAnnotation ??
    def?.node?.typeAnnotation?.typeAnnotation ??
    def?.node?.id?.typeAnnotation?.typeAnnotation ??
    null
  );
}
export function objectLiteralIdentifierValues(node) {
  if (node?.type !== "ObjectExpression") {
    return null;
  }
  const values = new Set();
  for (const property of node.properties ?? []) {
    if (property.type !== "Property") {
      return null;
    }
    const value = staticStringValue(property.value);
    if (!value || !isSqlIdentifierTokenValue(value)) {
      return null;
    }
    values.add(value);
  }
  return values;
}
export function templateInterpolationParts(node, index) {
  return {
    before:
      node.quasis[index]?.value?.cooked ?? node.quasis[index]?.value?.raw ?? "",
    after:
      node.quasis[index + 1]?.value?.cooked ??
      node.quasis[index + 1]?.value?.raw ??
      "",
  };
}
export function declarationOwnerNames(declaration) {
  const parent = declaration?.parent;
  return new Set(
    [
      parent?.name?.text,
      parent?.symbol?.getName?.(),
      parent?.localSymbol?.getName?.(),
    ].filter(Boolean),
  );
}
function normalizedSourcePath(value) {
  return String(value).replace(/\\/gu, "/");
}
export function declarationSourceMatches(declaration, source) {
  const fileName = declaration?.getSourceFile?.().fileName;
  return (
    typeof fileName === "string" &&
    typeof source === "string" &&
    normalizedSourcePath(fileName).endsWith(normalizedSourcePath(source))
  );
}
export function importedSpecifierName(def) {
  const node = def?.node;
  if (node?.type !== "ImportSpecifier") {
    return node?.local?.name ?? null;
  }
  return node.imported?.type === "Identifier"
    ? node.imported.name
    : node.imported?.value;
}
export function importSourceValue(def) {
  return def?.parent?.source?.value ?? def?.node?.parent?.source?.value;
}
