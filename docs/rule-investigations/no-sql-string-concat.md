# `antidrift/no-sql-string-concat`

## Definition

Disallow SQL strings assembled with interpolated values or concatenated values.

This is an injection-boundary rule, not a general "SQL keyword" scanner. Static SQL and bound parameters are allowed. A dynamic placeholder list such as `ids.map(() => "?").join(",")` is also allowed because the values are still passed separately to the database driver. Locally built arrays of static SQL fragments may be joined into `SET` / `WHERE` clauses; arbitrary dynamic fragments still report.

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

Current benchmark result after placeholder-list and static-fragment narrowing:

- 178 checked files.
- 0 parser errors.
- 10 `antidrift/no-sql-string-concat` findings.
- 0 `sonarjs/sql-queries` findings.

Widened local scan:

- An ad hoc scan across `/Users/sushi/code`, excluding the antidrift repo and Chaski roots, checked 6,916 SQL-keyword candidate files with this rule.
- It reported 452 findings and 1 parser error, but those findings are not accepted as stable-promotion drift yet.
- Sudocode CLI/server findings include static column lists, static condition lists, typed `ORDER BY` fragments, and bound values. Those are clean-pressure candidates for the static-fragment model, not automatically injection drift.
- Cloudflare Agents findings are largely tagged SQL template APIs such as `this.sql\`...\${value}...\``. Tagged SQL APIs need tag-aware classification before they can count as unsafe interpolation or clean parameterization.
- Many remaining findings are duplicate Chaski-derived local roots, so they do not provide independent replication.

## Promotion State

Status: `ready`, `stable: false`.

Do not promote until the widened non-Chaski findings are classified and at least one independent real drift repository is accepted. The current accepted drift is Chaski HogQL interpolation; Sudocode currently supplies clean-pressure controls for placeholder lists, static SQL fragments, and bound values.
