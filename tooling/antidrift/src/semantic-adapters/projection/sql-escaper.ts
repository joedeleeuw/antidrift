import ts from "typescript";

import {
  identifierName,
  isSyntaxType,
  syntaxChildren,
  syntaxField,
  templateQuasiTexts,
} from "../kernel/syntax-node.ts";
import { isFunctionLike } from "../kernel/syntax-function.ts";
import {
  methodReceiver,
  singleReturnExpression,
  staticString,
} from "./sql-syntax.ts";

export type SqlEscaperKind = "identifier" | "string";

const ESCAPER_KIND_BY_QUOTE = new Map<string, SqlEscaperKind>([
  ['"', "identifier"],
  ["'", "string"],
]);

const SQL_QUOTE_CHARACTERS = new Set(['"', "'", "`"]);

const IDENTIFIER_SKELETON = /^(?:"A"|`A`)(?:\.(?:"A"|`A`))*$/u;

function isQuoteReplacePattern(pattern: unknown, quote: string): boolean {
  if (!isSyntaxType(pattern, "Literal")) {
    return false;
  }
  const regex = syntaxField(pattern, "regex");
  const regexFlags = syntaxField(regex, "flags");
  return (
    (Boolean(regex) &&
      syntaxField(regex, "pattern") === quote &&
      typeof regexFlags === "string" &&
      regexFlags.includes("g")) ||
    syntaxField(pattern, "value") === quote
  );
}

function isEscapedReplaceCall(
  node: unknown,
  parameterName: string,
  quote: string
): boolean {
  if (identifierName(methodReceiver(node, "replace")) !== parameterName) {
    return false;
  }
  const [pattern, replacement] = syntaxChildren(node, "arguments");
  return (
    isQuoteReplacePattern(pattern, quote) &&
    staticString(replacement) === `${quote}${quote}`
  );
}

function sqlEscaperKindFromReturnExpression(
  node: unknown,
  parameterName: string
): SqlEscaperKind | null {
  const [escaped, ...extraExpressions] = syntaxChildren(node, "expressions");
  if (
    !isSyntaxType(node, "TemplateLiteral") ||
    escaped === undefined ||
    extraExpressions.length > 0
  ) {
    return null;
  }
  const [before = "", after = ""] = templateQuasiTexts(node);
  const kind = ESCAPER_KIND_BY_QUOTE.get(before);
  return kind !== undefined &&
    after === before &&
    isEscapedReplaceCall(escaped, parameterName, before)
    ? kind
    : null;
}

export function sqlEscaperFunctionKind(node: unknown): SqlEscaperKind | null {
  const declaredParameters = syntaxChildren(node, "params");
  const [parameter] = declaredParameters;
  const parameterName = identifierName(parameter);
  if (
    !isFunctionLike(node) ||
    declaredParameters.length !== 1 ||
    !parameterName
  ) {
    return null;
  }
  return sqlEscaperKindFromReturnExpression(
    singleReturnExpression(node),
    parameterName
  );
}

function tsStaticString(node: ts.Expression | undefined): string | null {
  return node && ts.isStringLiteralLike(node) ? node.text : null;
}

function tsSingleReturnExpression(
  node: ts.FunctionLikeDeclaration
): ts.Expression | null {
  const { body } = node;
  if (!body) {
    return null;
  }
  if (!ts.isBlock(body)) {
    return body;
  }
  const [statement, ...extraStatements] = body.statements;
  return statement &&
    extraStatements.length === 0 &&
    ts.isReturnStatement(statement)
    ? (statement.expression ?? null)
    : null;
}

function tsRegexMatchesGlobalQuote(
  pattern: ts.Expression | undefined,
  quote: string
): boolean {
  if (!pattern) {
    throw new TypeError(
      "sql-escaper: a replace call in a candidate escaper has no pattern argument"
    );
  }
  return (
    ts.isRegularExpressionLiteral(pattern) &&
    pattern.getText() === `/${quote}/g`
  );
}

function replaceReceiverRoot(receiver: ts.Expression): ts.Identifier | null {
  if (ts.isIdentifier(receiver)) {
    return receiver;
  }
  return ts.isPropertyAccessExpression(receiver) &&
    ts.isIdentifier(receiver.expression)
    ? receiver.expression
    : null;
}

function tsEscapedReplaceCall(
  node: ts.Expression,
  parameterName: string,
  quote: string
): boolean {
  if (
    !ts.isCallExpression(node) ||
    !ts.isPropertyAccessExpression(node.expression)
  ) {
    return false;
  }
  const method = node.expression.name.text;
  if (
    (method !== "replace" && method !== "replaceAll") ||
    replaceReceiverRoot(node.expression.expression)?.text !== parameterName
  ) {
    return false;
  }
  const [pattern, replacement] = node.arguments;
  const patternMatches =
    method === "replaceAll"
      ? tsStaticString(pattern) === quote
      : tsRegexMatchesGlobalQuote(pattern, quote);
  return patternMatches && tsStaticString(replacement) === `${quote}${quote}`;
}

function surroundingQuote(parts: readonly string[], index: number) {
  const quote = parts[index]?.at(-1);
  return quote && quote === parts[index + 1]?.[0] ? quote : null;
}

function tsTemplateSqlEscaperKind(
  node: ts.Expression | null,
  parameterName: string
): SqlEscaperKind | null {
  if (!node || !ts.isTemplateExpression(node)) {
    return null;
  }
  const expressions = node.templateSpans.map((span) => span.expression);
  const parts = [
    node.head.text,
    ...node.templateSpans.map((span) => span.literal.text),
  ];
  const skeleton = parts.join("A");
  const isStringSkeleton = skeleton === "'A'";
  if (
    expressions.length === 0 ||
    (!IDENTIFIER_SKELETON.test(skeleton) && !isStringSkeleton)
  ) {
    return null;
  }
  const escaped = expressions.every((expression, index) => {
    const quote = surroundingQuote(parts, index);
    return (
      quote !== null &&
      SQL_QUOTE_CHARACTERS.has(quote) &&
      tsEscapedReplaceCall(expression, parameterName, quote)
    );
  });
  if (!escaped) {
    return null;
  }
  return isStringSkeleton ? "string" : "identifier";
}

function escaperFunction(node: ts.Node): ts.FunctionLikeDeclaration | null {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node)
  ) {
    return node;
  }
  const { initializer } = ts.isVariableDeclaration(node) ? node : {};
  return initializer &&
    (ts.isFunctionExpression(initializer) || ts.isArrowFunction(initializer))
    ? initializer
    : null;
}

export function tsSqlEscaperDeclarationKind(
  node: ts.Node | undefined
): SqlEscaperKind | null {
  const escaper = node ? escaperFunction(node) : null;
  const [parameter, ...extraParameters] = escaper?.parameters ?? [];
  if (
    !escaper ||
    !parameter ||
    extraParameters.length > 0 ||
    !ts.isIdentifier(parameter.name)
  ) {
    return null;
  }
  return tsTemplateSqlEscaperKind(
    tsSingleReturnExpression(escaper),
    parameter.name.text
  );
}
