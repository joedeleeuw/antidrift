# `antidrift/no-sql-string-concat`

## Definition

Disallow SQL strings assembled with interpolated values or concatenated values.

This is an injection-boundary rule, not a general "SQL keyword" scanner. Static SQL and bound parameters are allowed. A dynamic placeholder list such as `ids.map(() => "?").join(",")` is also allowed because the values are still passed separately to the database driver.

## Should Flag

```ts
const query = `SELECT * FROM users WHERE id = '${userId}'`;
```

Why: a runtime value is interpolated into SQL text.

```ts
const query = "SELECT * FROM users WHERE id = " + userId;
```

Why: string concatenation makes value binding impossible to audit locally.

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

## Ecosystem

`sonarjs/sql-queries` is active as adjacent maintained coverage, but the benchmark currently reports 0 SonarJS findings against this rule's real Chaski/Sudocode SQL-like findings. Keep this rule until a supported ecosystem rule covers the same HogQL/template interpolation cases.

## Real-Corpus Evidence

Drift:

- `/Users/sushi/code/chaski/src/frontend/bff/api/gateways/posthog-gateway.ts` has 10 interpolated HogQL/SQL findings, including line 570 where order IDs are escaped into an `IN (...)` string.

Clean:

- `/Users/sushi/code/chaski/src/frontend/bff/api/gateways/bigquery-gateway.ts` uses static BigQuery text with bound `params`.
- `/Users/sushi/code/codebase-atlas/src` and `/Users/sushi/code/codebase-atlas/tools` stay clean across the SQL benchmark targets.
- `/Users/sushi/code/sudocode-main/server/src/routes/workflows.ts` line 1191 now stays clean for `IN (${placeholders})` where `placeholders` is produced by `issueIds.map(() => "?").join(",")` and values are bound with `.all(...issueIds)`.

Current benchmark result after placeholder-list narrowing:

- 178 checked files.
- 0 parser errors.
- 11 `antidrift/no-sql-string-concat` findings.
- 0 `sonarjs/sql-queries` findings.
- Remaining Sudocode finding: `/Users/sushi/code/sudocode-main/server/src/workflow/base-workflow-engine.ts` line 482 for dynamic `SET ${setClauses.join(", ")}`.

## Promotion State

Status: `ready`, `stable: false`.

Do not promote until dynamic SQL clause fragments are adjudicated. Placeholder-only `IN (...)` lists are clean; dynamic `SET` / `WHERE` clause assembly may need either a narrower safe-clause proof or an explicit project convention that pushes that shape into a query builder.
