# `antidrift/no-sql-string-concat`

## Definition

Disallow SQL strings assembled with interpolated values or concatenated values.

This is an injection-boundary rule, not a general "SQL keyword" scanner. Static SQL and bound parameters are allowed. Dynamic placeholder lists such as `ids.map(() => "?").join(",")`, and numbered Postgres placeholder fragments that interpolate only index plus/multiply arithmetic after `$`, are allowed because values remain separately bound to the database driver. Locally built arrays of static SQL fragments may be joined into `SET` / `WHERE` clauses; arbitrary dynamic fragments still report. Parameterized SQL template tags such as `sql`, `sqlQuery`, and `sqlRun` are treated as SQL binding APIs rather than raw string interpolation. Closed SQL identifier fragments are allowed only when the rule can prove the token set from local structure, such as a typed service-boundary union, a static object-literal column map, an anchored identifier regex guard that definitely exits on failure before deriving an identifier-shaped template, or a local quote-doubling SQL identifier escaper. Local SQL-fragment builder helpers are accepted only when their body is a single safe template, parameter interpolations are unquoted identifier positions, call-site arguments are identifier-safe, and dynamic value fragments pass through a proven string escaper. A template literal reports only when the unsafe interpolation itself is in SQL syntax; SQL-looking sample text elsewhere in the same template does not make unrelated interpolations a SQL sink.

## Should Flag

```ts
const query = `SELECT * FROM users WHERE id = '${userId}'`;
```

Why: a runtime value is interpolated into SQL text.

```ts
const query = "SELECT * FROM users WHERE id = " + userId;
```

Why: string concatenation makes value binding impossible to audit locally.

```ts
const fields = Object.keys(updates);
const setClause = fields.map((field) => `${field} = ?`).join(", ");
db.prepare(`UPDATE executions SET ${setClause} WHERE id = ?`).run(
  ...values,
  id,
);
```

Why: the SQL identifier list comes from dynamic object keys, not a closed column map.

```ts
function selectTable(tableName: string) {
  setQuery(`SELECT * FROM ${tableName} LIMIT 10`);
}
```

Why: a plain string table name is not a compile-time allowlist.

## Should Not Flag

```ts
db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
```

Why: the SQL text is static and the value is bound separately.

```ts
const placeholders = ids.map(() => "?").join(",");
db.prepare(`SELECT id FROM issues WHERE id IN (${placeholders})`).all(...ids);
```

Why: only placeholder tokens are interpolated; the actual values remain bound parameters.

```ts
const setClauses: string[] = [];
setClauses.push("title = ?");
setClauses.push("updated_at = ?");
db.prepare(`UPDATE workflows SET ${setClauses.join(", ")} WHERE id = ?`).run(
  title,
  updatedAt,
  id,
);
```

Why: the interpolated SQL text is assembled only from static fragments, and all values remain bound parameters.

```ts
await this.sqlRun`
  UPDATE files SET modified_at = ${timestamp} WHERE path = ${path}
`;
```

Why: the template is passed to a parameterized SQL tag; the interpolation is API-level value binding, not raw string construction.

```ts
async function listExecutions(options: {
  sortBy?: "created_at" | "updated_at";
  order?: "asc" | "desc";
}) {
  const sortBy = options.sortBy ?? "created_at";
  const order = options.order ?? "desc";
  return db.prepare(`
    SELECT * FROM executions
    ORDER BY ${sortBy} ${order.toUpperCase()}
  `);
}
```

Why: the interpolated identifier and direction tokens are closed by the typed service boundary.

```ts
const fieldToColumn = { title: "title", sprintId: "sprint_id" };
const col = fieldToColumn[key];
if (col) sets.push(`${col} = ?`);
sql.exec(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, ...params);
```

Why: the column token is selected from a static object-literal map, while values stay bound.

```ts
const VALID_NAMESPACE = /^[a-zA-Z][a-zA-Z0-9_]*$/;

class Workspace {
  private readonly tableName: string;

  constructor(ns: string) {
    if (!VALID_NAMESPACE.test(ns)) throw new Error("invalid namespace");
    this.tableName = `cf_workspace_${ns}`;
  }

  init() {
    return this.sql.run(`SELECT * FROM ${this.tableName}`);
  }
}
```

Why: the namespace is proven to be an SQL identifier token by an anchored regex guard that exits on failure, and the derived table name is interpolated only where SQL expects an identifier.

```ts
function sqlIdentifier(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

function sqlString(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

function modelSql(model: string, providerModel: string) {
  return `COALESCE(NULLIF(${model}, ''), NULLIF(${providerModel}, ''))`;
}

const sourceTable = [catalog, database, table].map(sqlIdentifier).join(".");
return `SELECT ${modelSql("model", "provider_model")} FROM ${sourceTable} WHERE created_at >= ${sqlString(start)}`;
```

Why: identifiers are quoted with embedded quote doubling, values are single-quoted with embedded quote doubling, and the helper only accepts identifier-safe arguments for unquoted SQL identifier positions.

```ts
const hugeOutput = "X".repeat(3_000_000);
await connectAndRun(`
  ws.send(JSON.stringify({
    input: { query: "SELECT * FROM everything" },
    output: "${hugeOutput}"
  }));
`);
```

Why: the SQL-looking text is sample payload data; the interpolation is not part of SQL execution or SQL syntax.

## Ecosystem

`sonarjs/sql-queries` is active as adjacent maintained coverage, but Sonar documents that rule as a security-sensitive formatted-query hotspot, not SQL injection detection. The local benchmark currently reports 0 SonarJS findings against this rule's 12 real-corpus findings, so it is not a replacement for the HogQL/template interpolation signal.

SQL tag ecosystems are relevant clean controls, not drift. Prisma documents `$queryRaw` and `$executeRaw` as tagged templates that parameterize values, while warning that identifiers such as table names and column names cannot be passed through placeholders. Drizzle documents its `sql` template as parameterized and identifier-aware through table/column objects and helpers such as `sql.identifier(...)`. That matches this rule's shape: treat known SQL tags as owned binding APIs, and keep raw string interpolation suspicious unless the identifier token set is locally closed.

External references checked during the June 9, 2026 review:

- [Sonar RSPEC-2077](https://rules.sonarsource.com/javascript/rspec-2077/) says the JavaScript rule highlights formatted SQL as a security-sensitive hotspot, does not detect SQL injection, and does not follow variables in its current implementation.
- [`eslint-plugin-sql/no-unsafe-query`](https://github.com/gajus/eslint-plugin-sql) requires a configured SQL tag for template literals; that is useful for codebases adopting a single SQL tag convention, but it is not equivalent to this rule's raw-HogQL/template plus local identifier-proof surface.
- [OWASP SQL Injection Prevention](https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html) recommends prepared statements for values and allow-list validation for table names, column names, and sort indicators when bind variables cannot represent those SQL fragments.
- [Prisma raw queries](https://docs.prisma.io/docs/orm/prisma-client/using-raw-sql/raw-queries) and [Drizzle `sql` templates](https://orm.drizzle.team/docs/sql) both document tagged SQL templates as value-parameterizing APIs while treating raw SQL / identifier interpolation as a separate higher-risk surface.

## Real-Corpus Evidence

Drift:

- Production: `/Users/sushi/code/chaski/src/frontend/bff/api/gateways/posthog-gateway.ts` has 14 interpolated HogQL/SQL findings, including line 570 where order IDs are escaped into an `IN (...)` string and the long-template findings at lines 626, 650, 1111, and 1367.
- Production: `/Users/sushi/code/chaski/src/frontend/crow-v2/backend/powersync.ts` line 20 builds an `INSERT INTO ${op.table} (${Object.keys(op.data).join(",")})` statement from operation payload structure.
- Production: `/Users/sushi/code/powersync-service/modules/module-mysql/src/api/MySQLRouteAPIAdapter.ts` line 235 interpolates `sourceTable.table` directly, even though neighboring code exposes escaped table-name APIs. This is the current lower-edge pressure case: raw table-name access still reports when a safer shape exists nearby.
- Lower-strength pressure: `/Users/sushi/code/sudocode-main/server/tests/integration/workflow/helpers/workflow-test-setup.ts` line 386 and `/Users/sushi/code/sudocode-main/server/tests/integration/execution/helpers/test-setup.ts` line 179 build `SET` clauses from `Object.keys(updates)`.
- Lower-strength pressure: `/Users/sushi/code/cloudflare-agents/examples/playground/src/demos/core/SqlDemo.tsx` line 133 builds a table query from a plain `string` table name.

Clean:

- `/Users/sushi/code/chaski/src/frontend/bff/api/gateways/bigquery-gateway.ts` uses static BigQuery text with bound `params`.
- `/Users/sushi/code/codebase-atlas/src` and `/Users/sushi/code/codebase-atlas/tools` stay clean across the SQL benchmark targets.
- `/Users/sushi/code/sudocode-main/server/src/routes/workflows.ts` line 1191 now stays clean for `IN (${placeholders})` where `placeholders` is produced by `issueIds.map(() => "?").join(",")` and values are bound with `.all(...issueIds)`.
- `/Users/sushi/code/sudocode-main/server/src/routes/workflows.ts` also stays clean for an allowlisted `ORDER BY ${sortColumn} ${sortOrder}` branch where both tokens are selected from a closed column/direction set.
- `/Users/sushi/code/sudocode-main/server/src/workflow/base-workflow-engine.ts` line 482 stays clean for `SET ${setClauses.join(", ")}` where each pushed clause is a static fragment and values are bound with `.run(...values)`.
- `/Users/sushi/code/sudocode-main/cli/src/operations/tags.ts`, `cli/src/operations/relationships.ts`, and `cli/src/id-generator.ts` stay clean for entity-table tokens selected from an `EntityType` union.
- `/Users/sushi/code/cloudflare-agents/packages/ai-chat/e2e/chat.spec.ts` line 1571 stays clean because the template serializes a browser test payload; the interpolation is a tool output string, not SQL assembly.
- `/Users/sushi/code/cloudflare-agents/packages/shell/src/filesystem.ts` stays clean because `VALID_NAMESPACE.test(ns)` exits on failure before deriving `this.tableName` and `this.indexName`, and those fields are interpolated only in SQL identifier positions.
- `/Users/sushi/code/opencode/packages/effect-drizzle-sqlite/src` and `/Users/sushi/code/opencode/packages/core/src/database/migration.ts` stay clean for Drizzle-style `sql` tags and `sql.identifier(...)` composition.
- `/Users/sushi/code/opencode/packages/stats/core/src/domain/inference.ts` stays clean for local `sqlIdentifier` / `sqlString` quote-doubling helpers, finite static `dimensionSql` fragments, and local SQL-fragment builders that only receive identifier-safe literal arguments.

Imported escaper clean:

- `/Users/sushi/code/powersync-service/modules/module-mysql/src/replication/BinLogStream.ts` line 311 stays clean because the imported `escapeMysqlTableName(table)` symbol resolves to a function whose body quote-doubles backticks in schema and table names before returning an identifier fragment.

Current benchmark result after placeholder-list, numbered Postgres placeholder-fragment, static-fragment, tag, closed-identifier, constructor-validated identifier narrowing, and type-aware PowerSync plans:

- 268 checked files.
- 0 parser errors.
- 16 `antidrift/no-sql-string-concat` findings.
- 0 `sonarjs/sql-queries` findings.
- PowerSync service contributes one raw-table finding and zero findings for imported escaper, configured escaped-identifier, and numbered-placeholder clean controls under type-aware plans.

Widened local scan:

- A fresh ad hoc SQL-pattern scan across `/Users/sushi/code`, excluding the antidrift repo and Chaski roots, checked 1,024 candidate files with this rule.
- It reported 168 findings and 0 parser errors.
- Sudocode's typed `ORDER BY ${sortBy} ${order}` service code now stays clean, as does the matching integration helper.
- Cloudflare Agents parameterized SQL tags, the Codemode static column-map update builder, and the Workspace sanitized namespace table identifiers now stay clean.
- The named Sudocode/Cloudflare findings are now classified: dynamic `Object.keys(updates)` update helpers and the playground table-name query are drift; browser/test payload SQL-looking strings and constructor-validated namespace table identifiers are clean. Many other findings are duplicate Chaski-derived local roots, so they do not provide independent replication.
- The scan is now reproducible through `pnpm policy:inventory-sql-broad`. A targeted broad run over PowerSync Service, Opencode, Cloudflare Agents, and Sudocode checked 707 SQL-candidate files, reported 31 custom findings, and reported 0 SonarJS findings. That run confirmed the parser-services boundary: escaped identifier controls such as `table.escapedIdentifier` and `escapeMysqlTableName(table)` report unless the inventory has TypeScript parser services to resolve the getter/helper proof. It also classified and fixed the PowerSync Postgres storage false positive by proving the dynamic fragment interpolates only generated `$<number>` placeholders while all values remain bound in `params`.

Current targeted broad finding classification:

| Class | Count | Examples | Handling |
|---|---:|---|---|
| Production drift | 1 | PowerSync `MySQLRouteAPIAdapter.ts:235` raw `sourceTable.table` interpolation | Keep reporting. |
| Parser-services-only conservative reports | 3 | PowerSync `BinLogStream.ts:311`, `WalStream.ts:437`, `replication-utils.ts:290` | Clean in type-aware plans; do not add name-only exemptions. |
| Lower-strength demo/test drift | 27 | Cloudflare demo `SqlDemo.tsx:133`, Sudocode dynamic test update helpers, PowerSync integration-test SQL interpolation | Keep as pressure evidence, not stable-production evidence. |
| Known false positives after this slice | 0 | Previously PowerSync Postgres storage numbered placeholder fragments | Fixed structurally. |

## Promotion State

Status: `ready`, `stable: false`.

The second independent sanitized identifier clean-control gap is resolved: Cloudflare Workspace covers anchored-regex/early-exit identifier derivation, and Opencode stats covers quote-doubling identifier and string escapers plus bounded local SQL-fragment builders. PowerSync service now supplies the lower-edge pressure case: raw `sourceTable.table` interpolation reports next to escaped table-name APIs, imported `escapeMysqlTableName(table)` stays clean through a TypeScript symbol-to-declaration proof, Postgres `SourceTable.escapedIdentifier` stays clean only through an explicit type/member contract that requires parser services to prove the receiver type, and Postgres storage numbered placeholder fragments stay clean through local structure. Production drift is Chaski plus PowerSync service; Sudocode, Cloudflare, and PowerSync tests provide useful but lower-strength drift pressure from test-helper/demo/integration-test code. Chaski, Codebase Atlas, Sudocode, Cloudflare, Opencode, and PowerSync service supply clean and pressure controls for placeholder lists, static SQL fragments, parameterized SQL tags, ORM-owned SQL composition, closed identifier/direction fragments, serialized payload data, constructor-validated identifiers, local and imported quote escapers, finite static object fragments, numbered placeholder fragments, and bound values.

Proven:

- Production drift exists in Chaski HogQL/template interpolation and PowerSync raw `sourceTable.table` interpolation.
- Bound-value composition stays clean for positional placeholder lists, parameterized SQL tags, ORM-owned SQL composition, and numbered Postgres placeholder fragments whose interpolation only creates `$<number>` placeholders.
- Closed identifier composition stays clean when proven by typed unions, static maps, anchored regex guards with failure exit, quote-doubling escapers, imported escapers, or configured safe identifier members with parser services.
- The targeted broad run over PowerSync Service, Opencode, Cloudflare Agents, and Sudocode is classified: 707 SQL-candidate files, 31 custom findings, 0 SonarJS findings, and no known type-aware false positives after the numbered-placeholder fix.
- The June 9 adversarial cleanup keeps the placeholder proof limited to `+` and `*` index arithmetic and restores short-circuit safety checks.

Unproven before stable:

- The wider `/Users/sushi/code` SQL inventory is not classified.
- Test/demo drift weighting is unresolved; another production drift repository may still be needed for stable promotion.
- Non-type-aware inventory cannot prove imported escapers or configured safe identifier members, by design.
- SQL tag ecosystems beyond the observed `sql`, `sqlQuery`, and `sqlRun` names remain unclassified.
- Positive guard, allowlist, quantifier, and regex-variant SQL identifier sanitizers remain uncharacterized against real code.
- Unsafe dynamic SQL-builder `+=`, `.concat()`, and array-join examples have not been found.
- Placeholder arithmetic beyond index `+`/`*` numeric expressions is unsupported until real clean code proves it.

The June 8, 2026 advisory review was grounded in repo reads and kept the rule at `ready`, not stable. The review agreed this is not ecosystem-covered and that the Cloudflare branch is deterministic enough to keep. PowerSync resolved the lower-edge and imported-escaper evidence blockers.

The June 9, 2026 advisory review (`reports/claude-rule-review-no-sql-string-concat-20260609-0803-rerun.md`) read the current repo and the external corpus directories. It found the PowerSync imported-escaper proof sound and the rule still locally ready, but not stable. Stable promotion remains blocked by:

- Equivalent guard shapes such as positive guards, quantifier forms, or allowlist checks remain uncharacterized against real code. The benchmark now inventories guard shapes and currently finds only the already-supported negative regex/exit shape in SQL context: `!VALID_NAMESPACE.test(ns)`.
- The targeted broad inventory is now classified for PowerSync, Opencode, Cloudflare Agents, and Sudocode. It has no known false positives after the numbered-placeholder fix, but much of the remaining evidence is lower-strength test/demo pressure rather than production drift.
- Imported escaper and configured safe-identifier-member proof are type-aware-only by design. The benchmark now runs a non-type-aware probe for PowerSync and measures the boundary directly: without parser services, `modules/module-mysql/src/replication/BinLogStream.ts:311`, `modules/module-postgres/src/replication/replication-utils.ts:290`, and `modules/module-postgres/src/replication/WalStream.ts:437` become conservative reports.
- Common parameterized SQL tag ecosystems beyond `sql`, `sqlQuery`, and `sqlRun` remain unclassified. The current benchmark inventories 199 SQL tagged-template uses and all are already in the allowed-name shape; Prisma `$queryRaw`, Kysely, Slonik, and aliased Drizzle tags still need real-code inventory before widening the allowlist.
- Concatenation false negatives are now measured: the benchmark sees 37 static SQL-builder `+=` appends, 8 dynamic SQL-builder `+=` candidates, 11 SQL sentence templates outside the old 200-character `SELECT ... FROM` pattern, and no `.concat()` or array-join SQL candidates. The 8 dynamic appends are classified clean: placeholder lists, joins of static condition fragments, or allowlisted sort/direction fragments. The widened sentence-pattern trigger now reports the four unsafe long Chaski templates at lines 626, 650, 1111, and 1367 while the Cloudflare/Opencode controls stay clean. Do not add SQL-builder append linting unless a real unsafe dynamic append appears.

Stable promotion waits on broader `/Users/sushi/code` classification beyond the targeted four-repo run, plus a decision on how much test/demo drift should count toward stable. Safe identifier controls remain parser-services-only; do not add name-only exemptions to make non-type-aware inventory quiet.
