# `antidrift/no-sql-string-concat`

## Definition

Disallow SQL strings assembled with interpolated values or concatenated values.

This is an injection-boundary rule, not a general "SQL keyword" scanner. Static SQL and bound parameters are allowed. A dynamic placeholder list such as `ids.map(() => "?").join(",")` is also allowed because the values are still passed separately to the database driver. Locally built arrays of static SQL fragments may be joined into `SET` / `WHERE` clauses; arbitrary dynamic fragments still report. Parameterized SQL template tags such as `sql`, `sqlQuery`, and `sqlRun` are treated as SQL binding APIs rather than raw string interpolation. Closed SQL identifier fragments are allowed only when the rule can prove the token set from local structure, such as a typed service-boundary union, a static object-literal column map, an anchored identifier regex guard that definitely exits on failure before deriving an identifier-shaped template, or a local quote-doubling SQL identifier escaper. Local SQL-fragment builder helpers are accepted only when their body is a single safe template, parameter interpolations are unquoted identifier positions, call-site arguments are identifier-safe, and dynamic value fragments pass through a proven string escaper. A template literal reports only when the unsafe interpolation itself is in SQL syntax; SQL-looking sample text elsewhere in the same template does not make unrelated interpolations a SQL sink.

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

`sonarjs/sql-queries` is active as adjacent maintained coverage, but Sonar documents that rule as a security-sensitive formatted-query hotspot, not SQL injection detection. The local benchmark currently reports 0 SonarJS findings against this rule's 11 real-corpus findings, so it is not a replacement for the HogQL/template interpolation signal.

SQL tag ecosystems are relevant clean controls, not drift. Prisma documents `$queryRaw` and `$executeRaw` as tagged templates that parameterize values, while warning that identifiers such as table names and column names cannot be passed through placeholders. Drizzle documents its `sql` template as parameterized and identifier-aware through table/column objects and helpers such as `sql.identifier(...)`. That matches this rule's shape: treat known SQL tags as owned binding APIs, and keep raw string interpolation suspicious unless the identifier token set is locally closed.

## Real-Corpus Evidence

Drift:

- Production: `/Users/sushi/code/chaski/src/frontend/bff/api/gateways/posthog-gateway.ts` has 10 interpolated HogQL/SQL findings, including line 570 where order IDs are escaped into an `IN (...)` string.
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

Known gap:

- `/Users/sushi/code/powersync-service/modules/module-mysql/src/replication/BinLogStream.ts` line 311 currently reports even though the call goes through imported `escapeMysqlTableName(table)`, whose implementation quote-doubles backticks in schema and table names. The rule proves local escapers only; imported escaper proof is unresolved.

Current benchmark result after placeholder-list, static-fragment, tag, closed-identifier, and constructor-validated identifier narrowing:

- 260 checked files.
- 0 parser errors.
- 11 `antidrift/no-sql-string-concat` findings.
- 0 `sonarjs/sql-queries` findings.

Widened local scan:

- A fresh ad hoc SQL-pattern scan across `/Users/sushi/code`, excluding the antidrift repo and Chaski roots, checked 1,024 candidate files with this rule.
- It reported 168 findings and 0 parser errors.
- Sudocode's typed `ORDER BY ${sortBy} ${order}` service code now stays clean, as does the matching integration helper.
- Cloudflare Agents parameterized SQL tags, the Codemode static column-map update builder, and the Workspace sanitized namespace table identifiers now stay clean.
- The named Sudocode/Cloudflare findings are now classified: dynamic `Object.keys(updates)` update helpers and the playground table-name query are drift; browser/test payload SQL-looking strings and constructor-validated namespace table identifiers are clean. Many other findings are duplicate Chaski-derived local roots, so they do not provide independent replication.

## Promotion State

Status: `ready`, `stable: false`.

The second independent sanitized identifier clean-control gap is resolved: Cloudflare Workspace covers anchored-regex/early-exit identifier derivation, and Opencode stats covers quote-doubling identifier and string escapers plus bounded local SQL-fragment builders. PowerSync service now supplies the lower-edge pressure case: raw `sourceTable.table` interpolation reports next to escaped table-name APIs. Production drift is Chaski plus PowerSync service; Sudocode and Cloudflare provide useful but lower-strength drift pressure from test-helper and demo/playground programs. Chaski, Codebase Atlas, Sudocode, Cloudflare, Opencode, and PowerSync service supply clean and pressure controls for placeholder lists, static SQL fragments, parameterized SQL tags, ORM-owned SQL composition, closed identifier/direction fragments, serialized payload data, constructor-validated identifiers, local quote escapers, finite static object fragments, bound values, and imported-escaper false-positive pressure.

The June 8, 2026 advisory review was grounded in repo reads and kept the rule at `ready`, not stable. The review agreed this is not ecosystem-covered and that the Cloudflare branch is deterministic enough to keep. PowerSync resolves the lower-edge blocker but replaces it with a sharper production concern:

- Equivalent guard shapes such as positive guards, quantifier forms, or allowlist checks remain uncharacterized against real code.
- Imported SQL escapers are not proven across files; `escapeMysqlTableName(table)` is a real false-positive pressure case.

Stable promotion waits on either imported-escaper proof or an explicit decision that cross-file SQL escaper validation is outside this rule's stable scope.
