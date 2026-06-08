# `antidrift/no-sql-string-concat`

## Definition

Disallow SQL strings assembled with interpolated values or concatenated values.

This is an injection-boundary rule, not a general "SQL keyword" scanner. Static SQL and bound parameters are allowed. A dynamic placeholder list such as `ids.map(() => "?").join(",")` is also allowed because the values are still passed separately to the database driver. Locally built arrays of static SQL fragments may be joined into `SET` / `WHERE` clauses; arbitrary dynamic fragments still report. Parameterized SQL template tags such as `sql`, `sqlQuery`, and `sqlRun` are treated as SQL binding APIs rather than raw string interpolation. Closed SQL identifier fragments are allowed only when the rule can prove the token set from local structure, such as a typed service-boundary union, a static object-literal column map, or an anchored identifier regex guard that definitely exits on failure before deriving an identifier-shaped template. These proofs are accepted only in an identifier/direction position. A template literal reports only when the unsafe interpolation itself is in SQL syntax; SQL-looking sample text elsewhere in the same template does not make unrelated interpolations a SQL sink.

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

`sonarjs/sql-queries` is active as adjacent maintained coverage, but the benchmark currently reports 0 SonarJS findings against this rule's real Chaski/Sudocode SQL-like findings. Keep this rule until a supported ecosystem rule covers the same HogQL/template interpolation cases.

## Real-Corpus Evidence

Drift:

- `/Users/sushi/code/chaski/src/frontend/bff/api/gateways/posthog-gateway.ts` has 10 interpolated HogQL/SQL findings, including line 570 where order IDs are escaped into an `IN (...)` string.
- `/Users/sushi/code/sudocode-main/server/tests/integration/workflow/helpers/workflow-test-setup.ts` line 386 and `/Users/sushi/code/sudocode-main/server/tests/integration/execution/helpers/test-setup.ts` line 179 build `SET` clauses from `Object.keys(updates)`.
- `/Users/sushi/code/cloudflare-agents/examples/playground/src/demos/core/SqlDemo.tsx` line 133 builds a table query from a plain `string` table name.

Clean:

- `/Users/sushi/code/chaski/src/frontend/bff/api/gateways/bigquery-gateway.ts` uses static BigQuery text with bound `params`.
- `/Users/sushi/code/codebase-atlas/src` and `/Users/sushi/code/codebase-atlas/tools` stay clean across the SQL benchmark targets.
- `/Users/sushi/code/sudocode-main/server/src/routes/workflows.ts` line 1191 now stays clean for `IN (${placeholders})` where `placeholders` is produced by `issueIds.map(() => "?").join(",")` and values are bound with `.all(...issueIds)`.
- `/Users/sushi/code/sudocode-main/server/src/workflow/base-workflow-engine.ts` line 482 stays clean for `SET ${setClauses.join(", ")}` where each pushed clause is a static fragment and values are bound with `.run(...values)`.
- `/Users/sushi/code/cloudflare-agents/packages/ai-chat/e2e/chat.spec.ts` line 1571 stays clean because the template serializes a browser test payload; the interpolation is a tool output string, not SQL assembly.
- `/Users/sushi/code/cloudflare-agents/packages/shell/src/filesystem.ts` stays clean because `VALID_NAMESPACE.test(ns)` exits on failure before deriving `this.tableName` and `this.indexName`, and those fields are interpolated only in SQL identifier positions.

Current benchmark result after placeholder-list, static-fragment, tag, closed-identifier, and constructor-validated identifier narrowing:

- 236 checked files.
- 0 parser errors.
- 10 `antidrift/no-sql-string-concat` findings.
- 0 `sonarjs/sql-queries` findings.

Widened local scan:

- A fresh ad hoc SQL-pattern scan across `/Users/sushi/code`, excluding the antidrift repo and Chaski roots, checked 1,024 candidate files with this rule.
- It reported 168 findings and 0 parser errors.
- Sudocode's typed `ORDER BY ${sortBy} ${order}` service code now stays clean, as does the matching integration helper.
- Cloudflare Agents parameterized SQL tags, the Codemode static column-map update builder, and the Workspace sanitized namespace table identifiers now stay clean.
- The named Sudocode/Cloudflare findings are now classified: dynamic `Object.keys(updates)` update helpers and the playground table-name query are drift; browser/test payload SQL-looking strings and constructor-validated namespace table identifiers are clean. Many other findings are duplicate Chaski-derived local roots, so they do not provide independent replication.

## Promotion State

Status: `ready`, `stable: false`.

The sanitized dynamic identifier gap is resolved in the local rule and validated against Cloudflare Workspace. Drift still replicates across Chaski, Sudocode, and Cloudflare, while Chaski, Codebase Atlas, Sudocode, and Cloudflare supply clean controls for placeholder lists, static SQL fragments, parameterized SQL tags, closed identifier/direction fragments, serialized payload data, constructor-validated identifiers, and bound values.

The June 8, 2026 advisory review was grounded in repo reads and kept the rule at `ready`, not stable. The review agreed this is not ecosystem-covered and that the Cloudflare branch is deterministic enough to keep, but it found three stable-promotion blockers:

- The constructor-validated dynamic identifier clean shape currently exists in only one independent repo.
- Equivalent guard shapes such as positive guards, quantifier forms, or allowlist checks are uncharacterized against real code.
- The guard branch's lower edge still needs real-program pressure: a value that looks guarded but is not, and must still report.

Stable promotion waits on that evidence, not on a known code blocker.
