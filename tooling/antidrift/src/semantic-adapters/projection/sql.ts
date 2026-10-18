import { fieldOf, templateQuasiTexts } from "../kernel/syntax-node.ts";

export type SafeIdentifierMemberSpecInput = {
  readonly type?: unknown;
  readonly member?: unknown;
};

export type SafeIdentifierMemberSpec = {
  type: string;
  member: string;
};

export type SafeTemplateImportedTagSpecInput = {
  readonly module?: unknown;
  readonly export?: unknown;
  readonly evidence?: unknown;
};

export type SafeTemplateMemberTagSpecInput = {
  readonly type?: unknown;
  readonly member?: unknown;
  readonly source?: unknown;
  readonly evidence?: unknown;
};

export type SafeTemplateTagSpecInput =
  | SafeTemplateImportedTagSpecInput
  | SafeTemplateMemberTagSpecInput;

export type SafeTemplateImportedTagSpec = {
  module: string;
  exportName: string;
};

export type SafeTemplateMemberTagSpec = {
  type: string;
  member: string;
  source: string;
};

export type SafeTemplateTagSpecs = {
  imported: SafeTemplateImportedTagSpec[];
  members: SafeTemplateMemberTagSpec[];
};

export const SQL_INTERPOLATION_BEFORE_KEYWORDS = Object.freeze([
  "FROM",
  "JOIN",
  "UPDATE",
  "INTO",
  "TABLE",
  "WHERE",
  "AND",
  "OR",
  "IN",
  "VALUES",
  "SET",
  "ON",
  "LIKE",
  "ORDER BY",
  "GROUP BY",
  "PARTITION BY",
]);

export const SQL_INTERPOLATION_AFTER_KEYWORDS = Object.freeze([
  "AND",
  "OR",
  "WHERE",
  "FROM",
  "JOIN",
  "ORDER BY",
  "GROUP BY",
  "PARTITION BY",
  "LIMIT",
  "OFFSET",
  "HAVING",
  "SET",
  "VALUES",
  "IN",
]);

const SQL_QUOTES = new Set(["'", '"', "`"]);

const SQL_INTERPOLATION_OPERATORS = ["=", "(", ","];

export function isSqlIdentifierToken(token: string): boolean {
  return /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?$/u.test(token);
}

export type SqlDirectionToken = "ASC" | "DESC" | "asc" | "desc";

export function isSqlDirectionToken(token: string): token is SqlDirectionToken {
  return (
    token === "ASC" || token === "DESC" || token === "asc" || token === "desc"
  );
}

export function isSqlIdentifierContext(before: string, after: string) {
  return (
    /(?:ORDER\s+BY|GROUP\s+BY|PARTITION\s+BY|FROM|JOIN|UPDATE|INTO|TABLE)\s*$/iu.test(
      before
    ) || /^\s*=/u.test(after)
  );
}

export function normalizedSqlContext(sqlText: string): string {
  return sqlText.toUpperCase().replace(/\s+/gu, " ").trim();
}

export function removeTrailingSqlQuote(sqlText: string): string {
  const trimmed = sqlText.trimEnd();
  const last = trimmed.at(-1);
  return last !== undefined && SQL_QUOTES.has(last)
    ? trimmed.slice(0, -1).trimEnd()
    : trimmed;
}

export function endsWithSqlInterpolationKeyword(sqlText: string): boolean {
  const normalized = normalizedSqlContext(removeTrailingSqlQuote(sqlText));
  return SQL_INTERPOLATION_BEFORE_KEYWORDS.some(
    (keyword) =>
      normalized === keyword ||
      normalized.endsWith(` ${keyword}`) ||
      normalized.endsWith(` ${keyword} (`)
  );
}

export function containsSqlStatementContext(sqlText: string): boolean {
  return /\b(?:SELECT|FROM|JOIN|WHERE|VALUES|UPDATE|INSERT|DELETE|ORDER BY|GROUP BY|HAVING)\b/u.test(
    normalizedSqlContext(sqlText)
  );
}

export function endsWithSqlInterpolationOperator(sqlText: string): boolean {
  const normalized = removeTrailingSqlQuote(sqlText);
  return (
    containsSqlStatementContext(normalized) &&
    SQL_INTERPOLATION_OPERATORS.some((operator) =>
      normalized.endsWith(operator)
    )
  );
}

export function startsWithSqlInterpolationKeyword(sqlText: string): boolean {
  const trimmed = sqlText.trimStart();
  const first = trimmed.at(0);
  const unquoted =
    first !== undefined && SQL_QUOTES.has(first)
      ? trimmed.slice(1).trimStart()
      : trimmed;
  const normalized = normalizedSqlContext(unquoted);
  return (
    normalized.startsWith(")") ||
    normalized.startsWith(",") ||
    SQL_INTERPOLATION_AFTER_KEYWORDS.some((keyword) =>
      normalized.startsWith(keyword)
    )
  );
}

export function isSqlInterpolationContext(
  before: string,
  after: string
): boolean {
  const beforeTail = before.slice(-160);
  const afterHead = after.slice(0, 160);
  return (
    endsWithSqlInterpolationKeyword(beforeTail) ||
    endsWithSqlInterpolationOperator(beforeTail) ||
    startsWithSqlInterpolationKeyword(afterHead)
  );
}

export function templateStaticPartsAreSqlIdentifierSafe(
  node: unknown
): boolean {
  return isSqlIdentifierToken(templateQuasiTexts(node).join("A"));
}

export function valuesAreSqlIdentifiers(
  tokens: ReadonlySet<string> | null | undefined
): boolean {
  return (
    tokens !== null &&
    tokens !== undefined &&
    tokens.size > 0 &&
    [...tokens].every((token) => isSqlIdentifierToken(token))
  );
}

export function valuesAreSqlDirections(
  tokens: ReadonlySet<string> | null | undefined
): boolean {
  return (
    tokens !== null &&
    tokens !== undefined &&
    tokens.size > 0 &&
    [...tokens].every((token) => isSqlDirectionToken(token))
  );
}

export function safeIdentifierMemberSpecs(options: {
  readonly safeIdentifierMembers?: readonly SafeIdentifierMemberSpecInput[];
}): SafeIdentifierMemberSpec[] {
  return (options.safeIdentifierMembers ?? []).flatMap(({ type, member }) =>
    typeof type === "string" && typeof member === "string"
      ? [{ type, member }]
      : []
  );
}

export function safeTemplateTagSpecs(options: {
  readonly safeTemplateTags?: readonly SafeTemplateTagSpecInput[];
}): SafeTemplateTagSpecs {
  const imported: SafeTemplateImportedTagSpec[] = [];
  const members: SafeTemplateMemberTagSpec[] = [];
  for (const spec of options.safeTemplateTags ?? []) {
    const moduleName = fieldOf(spec, "module");
    const exportName = fieldOf(spec, "export");
    const type = fieldOf(spec, "type");
    const member = fieldOf(spec, "member");
    const source = fieldOf(spec, "source");
    if (typeof moduleName === "string" && typeof exportName === "string") {
      imported.push({ module: moduleName, exportName });
      continue;
    }
    if (
      typeof type === "string" &&
      typeof member === "string" &&
      typeof source === "string" &&
      /[/\\]/u.test(source)
    ) {
      members.push({ type, member, source });
    }
  }
  return { imported, members };
}
