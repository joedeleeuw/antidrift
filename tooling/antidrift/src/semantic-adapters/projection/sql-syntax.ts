import {
  identifierName,
  isSyntaxNode,
  isSyntaxType,
  syntaxChildren,
  syntaxField,
  templateQuasiTexts,
} from "../kernel/syntax-node.ts";

export const SQL_PREFIX_PATTERN =
  /\b(?:SELECT\b[\s\S]{0,200}?\bFROM\b|INSERT\s+INTO\b|UPDATE\s+[\w."`]+\s+SET\b|DELETE\s+FROM\b|DROP\s+TABLE\b)/iu;

const SQL_SENTENCE_PATTERN =
  /\b(?:SELECT\b[\s\S]*?\bFROM\b|INSERT\s+INTO\b|UPDATE\b[\s\S]*?\bSET\b|DELETE\s+FROM\b|DROP\s+TABLE\b)/iu;

const SQL_QUOTES = ["'", '"', "`"];

const FRAGMENT_JOIN_SEPARATORS = new Set([",", ", ", " AND ", " OR "]);

export function containsSqlStatement(sqlText: string): boolean {
  return SQL_PREFIX_PATTERN.test(sqlText) || SQL_SENTENCE_PATTERN.test(sqlText);
}

export function templateText(template: unknown): string {
  return templateQuasiTexts(template).join(" ");
}

export function staticString(node: unknown): string | null {
  const literal = syntaxField(node, "value");
  if (isSyntaxType(node, "Literal") && typeof literal === "string") {
    return literal;
  }
  if (
    isSyntaxType(node, "TemplateLiteral") &&
    syntaxChildren(node, "expressions").length === 0
  ) {
    return templateText(node);
  }
  return null;
}

export function singleReturnExpression(node: unknown) {
  const body = syntaxField(node, "body");
  if (
    isSyntaxType(node, "ArrowFunctionExpression") &&
    !isSyntaxType(body, "BlockStatement")
  ) {
    return body;
  }
  const statements = syntaxChildren(body, "body");
  if (!isSyntaxType(body, "BlockStatement") || statements.length !== 1) {
    return null;
  }
  const [statement] = statements;
  return isSyntaxType(statement, "ReturnStatement")
    ? syntaxField(statement, "argument")
    : null;
}

export function templateInterpolationParts(template: unknown, index: number) {
  const texts = templateQuasiTexts(template);
  return { before: texts[index] ?? "", after: texts[index + 1] ?? "" };
}

function hasOpenSqlQuote(sqlText: string): boolean {
  return SQL_QUOTES.some((quote) => {
    let open = false;
    for (let position = 0; position < sqlText.length; position += 1) {
      if (sqlText[position] === quote) {
        if (sqlText[position + 1] === quote) {
          position += 1;
        } else {
          open = !open;
        }
      }
    }
    return open;
  });
}

export function isUnquotedSqlInterpolation(
  before: string,
  after: string
): boolean {
  return !hasOpenSqlQuote(before) && !/^\s*['"`]/u.test(after);
}

export function isAllowedSqlFragmentJoinSeparator(
  separator: string | null
): boolean {
  return separator !== null && FRAGMENT_JOIN_SEPARATORS.has(separator);
}

export function methodReceiver(call: unknown, methodName: string) {
  const member = syntaxField(call, "callee");
  if (
    !isSyntaxType(call, "CallExpression") ||
    !isSyntaxType(member, "MemberExpression") ||
    syntaxField(member, "computed") === true ||
    identifierName(syntaxField(member, "property")) !== methodName
  ) {
    return null;
  }
  return syntaxField(member, "object");
}

export function joinSeparator(joinCall: unknown): string | null {
  const [separator] = syntaxChildren(joinCall, "arguments");
  return separator ? staticString(separator) : ",";
}

export function isCallbackExpression(node: unknown): boolean {
  return (
    isSyntaxType(node, "ArrowFunctionExpression") ||
    isSyntaxType(node, "FunctionExpression")
  );
}

export function sqlPropertyKeyName(key: unknown): string {
  if (isSyntaxType(key, "Identifier")) {
    return identifierName(key) ?? "";
  }
  if (isSyntaxType(key, "Literal")) {
    return String(syntaxField(key, "value"));
  }
  return "";
}

export function statementExits(node: unknown): boolean {
  if (!isSyntaxNode(node)) {
    return false;
  }
  if (node.type === "ThrowStatement" || node.type === "ReturnStatement") {
    return true;
  }
  if (node.type === "BlockStatement") {
    return statementExits(syntaxChildren(node, "body").at(-1));
  }
  return (
    node.type === "IfStatement" &&
    statementExits(syntaxField(node, "consequent")) &&
    statementExits(syntaxField(node, "alternate"))
  );
}

export function collectReturnArguments(node: unknown, returned: unknown[]) {
  if (isSyntaxType(node, "ReturnStatement")) {
    returned.push(syntaxField(node, "argument"));
    return;
  }
  if (isSyntaxType(node, "BlockStatement")) {
    for (const statement of syntaxChildren(node, "body")) {
      collectReturnArguments(statement, returned);
    }
    return;
  }
  if (isSyntaxType(node, "IfStatement")) {
    collectReturnArguments(syntaxField(node, "consequent"), returned);
    collectReturnArguments(syntaxField(node, "alternate"), returned);
  }
}
