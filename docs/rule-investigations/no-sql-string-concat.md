# `antidrift/no-sql-string-concat`

## Definition

Disallow SQL strings assembled with interpolated values or concatenated values.

This is an injection-boundary rule, not a general "SQL keyword" scanner. Static SQL and bound parameters are allowed. A dynamic placeholder list such as `ids.map(() => "?").join(",")` is also allowed because the values are still passed separately to the database driver. Locally built arrays of static SQL fragments may be joined into `SET` / `WHERE` clauses; arbitrary dynamic fragments still report. Parameterized SQL template tags such as `sql`, `sqlQuery`, and `sqlRun` are treated as SQL binding APIs rather than raw string interpolation. Closed SQL identifier fragments are allowed only when the rule can prove the token set from local structure, such as a typed service-boundary union or a static object-literal column map, and only in an identifier/direction position.

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
db.prepare(`UPDATE executions SET ${setClause} WHERE id = ?`).run(...values, id);
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

## Ecosystem

`sonarjs/sql-queries` is active as adjacent maintained coverage, but the benchmark currently reports 0 SonarJS findings against this rule's real Chaski/Sudocode SQL-like findings. Keep this rule until a supported ecosystem rule covers the same HogQL/template interpolation cases.

## Real-Corpus Evidence

Drift:

- `/Users/sushi/code/chaski/src/frontend/bff/api/gateways/posthog-gateway.ts` has 10 interpolated HogQL/SQL findings, including line 570 where order IDs are escaped into an `IN (...)` string.

Clean:

- `/Users/sushi/code/chaski/src/frontend/bff/api/gateways/bigquery-gateway.ts` uses static BigQuery text with bound `params`.
- `/Users/sushi/code/codebase-atlas/src` and `/Users/sushi/code/codebase-atlas/tools` stay clean across the SQL benchmark targets.
- `/Users/sushi/code/sudocode-main/server/src/routes/workflows.ts` line 1191 now stays clean for `IN (${placeholders})` where `placeholders` is produced by `issueIds.map(() => "?").join(",")` and values are bound with `.all(...issueIds)`.
- `/Users/sushi/code/sudocode-main/server/src/workflow/base-workflow-engine.ts` line 482 stays clean for `SET ${setClauses.join(", ")}` where each pushed clause is a static fragment and values are bound with `.run(...values)`.

Current benchmark result after placeholder-list, static-fragment, tag, and closed-identifier narrowing:

- 190 checked files.
- 0 parser errors.
- 10 `antidrift/no-sql-string-concat` findings.
- 0 `sonarjs/sql-queries` findings.

Widened local scan:

- A fresh ad hoc SQL-pattern scan across `/Users/sushi/code`, excluding the antidrift repo and Chaski roots, checked 1,024 candidate files with this rule.
- It reported 168 findings and 0 parser errors.
- Sudocode's typed `ORDER BY ${sortBy} ${order}` service code now stays clean, as does the matching integration helper.
- Cloudflare Agents parameterized SQL tags and the Codemode static column-map update builder now stay clean.
- Remaining Sudocode/Cloudflare findings include dynamic `Object.keys(updates)` update helpers, a playground table-name query assembled from a plain `string`, and test/browser-evaluation strings. Many other findings are duplicate Chaski-derived local roots, so they do not provide independent replication.

## Promotion State

Status: `ready`, `stable: false`.

Do not promote until the remaining widened findings are classified or remediated. The current accepted drift is Chaski HogQL interpolation; Sudocode and Cloudflare now supply clean controls for placeholder lists, static SQL fragments, parameterized SQL tags, closed identifier/direction fragments, and bound values.
