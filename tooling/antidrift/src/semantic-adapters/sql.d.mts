export type SqlDirectionToken = "ASC" | "DESC" | "asc" | "desc";

export interface SqlTemplateLike {
  quasis: Array<{
    value: {
      cooked?: string | null;
      raw?: string;
    };
  }>;
}

export interface SafeIdentifierMemberSpecInput {
  type?: unknown;
  member?: unknown;
}

export interface SafeIdentifierMemberSpec {
  type: string;
  member: string;
}

export const SQL_INTERPOLATION_BEFORE_KEYWORDS: readonly string[];
export const SQL_INTERPOLATION_AFTER_KEYWORDS: readonly string[];

export function isSqlIdentifierTokenValue(value: string): boolean;
export function isSqlDirectionTokenValue(
  value: string,
): value is SqlDirectionToken;
export function isSqlIdentifierContext(before: string, after: string): boolean;
export function normalizedSqlContext(value: string): string;
export function removeTrailingSqlQuote(value: string): string;
export function endsWithSqlInterpolationKeyword(value: string): boolean;
export function containsSqlStatementContext(value: string): boolean;
export function endsWithSqlInterpolationOperator(value: string): boolean;
export function startsWithSqlInterpolationKeyword(value: string): boolean;
export function isSqlInterpolationContext(
  before: string,
  after: string,
): boolean;
export function templateStaticPartsAreSqlIdentifierSafe(
  node: SqlTemplateLike,
): boolean;
export function valuesAreSqlIdentifiers(
  values: ReadonlySet<string> | null | undefined,
): boolean;
export function valuesAreSqlDirections(
  values: ReadonlySet<string> | null | undefined,
): boolean;
export function safeIdentifierMemberSpecs(options: {
  safeIdentifierMembers?: readonly SafeIdentifierMemberSpecInput[];
}): SafeIdentifierMemberSpec[];
