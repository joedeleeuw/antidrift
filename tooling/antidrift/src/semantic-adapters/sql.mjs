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

export function isSqlIdentifierTokenValue(value) {
  return /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?$/u.test(value);
}

export function isSqlDirectionTokenValue(value) {
  return (
    value === "ASC" || value === "DESC" || value === "asc" || value === "desc"
  );
}

export function isSqlIdentifierContext(before, after) {
  return (
    /(?:ORDER\s+BY|GROUP\s+BY|PARTITION\s+BY|FROM|JOIN|UPDATE|INTO|TABLE)\s*$/iu.test(
      before,
    ) || /^\s*=/.test(after)
  );
}

export function normalizedSqlContext(value) {
  return value.toUpperCase().replace(/\s+/gu, " ").trim();
}

export function removeTrailingSqlQuote(value) {
  const trimmed = value.trimEnd();
  const last = trimmed.at(-1);
  return last === "'" || last === '"' || last === "`"
    ? trimmed.slice(0, -1).trimEnd()
    : trimmed;
}

export function endsWithSqlInterpolationKeyword(value) {
  const normalized = normalizedSqlContext(removeTrailingSqlQuote(value));
  return SQL_INTERPOLATION_BEFORE_KEYWORDS.some(
    (keyword) =>
      normalized === keyword ||
      normalized.endsWith(` ${keyword}`) ||
      normalized.endsWith(` ${keyword} (`),
  );
}

export function containsSqlStatementContext(value) {
  return /\b(?:SELECT|FROM|JOIN|WHERE|VALUES|UPDATE|INSERT|DELETE|ORDER BY|GROUP BY|HAVING)\b/u.test(
    normalizedSqlContext(value),
  );
}

export function endsWithSqlInterpolationOperator(value) {
  const normalized = removeTrailingSqlQuote(value);
  return (
    containsSqlStatementContext(normalized) &&
    ["=", "(", ","].some((operator) => normalized.endsWith(operator))
  );
}

export function startsWithSqlInterpolationKeyword(value) {
  const trimmed = value.trimStart();
  const first = trimmed.at(0);
  const unquoted =
    first === "'" || first === '"' || first === "`"
      ? trimmed.slice(1).trimStart()
      : trimmed;
  const normalized = normalizedSqlContext(unquoted);
  return (
    normalized.startsWith(")") ||
    normalized.startsWith(",") ||
    SQL_INTERPOLATION_AFTER_KEYWORDS.some((keyword) =>
      normalized.startsWith(keyword),
    )
  );
}

export function isSqlInterpolationContext(before, after) {
  const beforeTail = before.slice(-160);
  const afterHead = after.slice(0, 160);
  return (
    endsWithSqlInterpolationKeyword(beforeTail) ||
    endsWithSqlInterpolationOperator(beforeTail) ||
    startsWithSqlInterpolationKeyword(afterHead)
  );
}

export function templateStaticPartsAreSqlIdentifierSafe(node) {
  const text = node.quasis
    .map((quasi) => quasi.value.cooked ?? quasi.value.raw ?? "")
    .join("A");
  return isSqlIdentifierTokenValue(text);
}

export function valuesAreSqlIdentifiers(values) {
  return Boolean(values?.size) && [...values].every(isSqlIdentifierTokenValue);
}

export function valuesAreSqlDirections(values) {
  return Boolean(values?.size) && [...values].every(isSqlDirectionTokenValue);
}

export function safeIdentifierMemberSpecs(options) {
  return (options.safeIdentifierMembers ?? [])
    .filter(
      ({ type, member }) =>
        typeof type === "string" && typeof member === "string",
    )
    .map(({ type, member }) => ({ type, member }));
}

function isPathQualifiedSource(value) {
  return typeof value === "string" && /[/\\]/u.test(value);
}

export function safeTemplateTagSpecs(options) {
  const imported = [];
  const members = [];
  for (const spec of options.safeTemplateTags ?? []) {
    if (typeof spec?.module === "string" && typeof spec.export === "string") {
      imported.push({ module: spec.module, exportName: spec.export });
      continue;
    }
    if (
      typeof spec?.type === "string" &&
      typeof spec.member === "string" &&
      isPathQualifiedSource(spec.source)
    ) {
      members.push({
        type: spec.type,
        member: spec.member,
        source: spec.source,
      });
    }
  }
  return { imported, members };
}
