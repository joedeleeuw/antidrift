# `antidrift/no-sql-string-concat`

## Definition

Disallow SQL strings assembled with interpolated values or concatenated values.

This is an injection-boundary rule, not a general "SQL keyword" scanner. Static SQL and bound parameters are allowed. Dynamic placeholder lists such as `ids.map(() => "?").join(",")`, and numbered Postgres placeholder fragments that interpolate only index plus/multiply arithmetic after `$`, are allowed because values remain separately bound to the database driver. Locally built arrays of static SQL fragments may be joined into `SET` / `WHERE` clauses; arbitrary dynamic fragments still report. SQL template tags and `.sql` member APIs are not trusted by name; Drizzle, Cloudflare Durable Object SQL, PowerSync `db.sql`, Prisma, Kysely, Slonik, and aliases need import or declaration-source provenance that proves the binding API before they can be clean. The current implementation has explicit clean proof for configured Drizzle imports, Cloudflare core `Agent.sql`, and PowerSync `AbstractPostgresConnection.sql`; local lookalike `sql`, `db.sql`, and `class Agent { sql() {} }` tags still report. Closed SQL identifier fragments are allowed only when the rule can prove the token set from local structure, such as a typed service-boundary union, a static object-literal column map, an anchored identifier regex guard that definitely exits on failure before deriving an identifier-shaped template, or a local quote-doubling SQL identifier escaper. Local SQL-fragment builder helpers are accepted only when their body is a single safe template, parameter interpolations are unquoted identifier positions, call-site arguments are identifier-safe, and dynamic value fragments pass through a proven string escaper. A template literal reports only when the unsafe interpolation itself is in SQL syntax; SQL-looking sample text elsewhere in the same template does not make unrelated interpolations a SQL sink.

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

`sonarjs/sql-queries` is active as adjacent maintained coverage, but Sonar documents that rule as a security-sensitive formatted-query hotspot, not SQL injection detection. The local benchmark currently reports 0 SonarJS findings against this rule's 145 custom findings, so it is not a replacement for the HogQL/template interpolation signal. Most non-anchor findings are high-noise SQL-builder/tagged-template inventory after removing name-only member proof.

SQL tag ecosystems are relevant clean controls, not drift. Prisma documents `$queryRaw` and `$executeRaw` as tagged templates that parameterize values, while warning that identifiers such as table names and column names cannot be passed through placeholders. Drizzle documents its `sql` template as parameterized and identifier-aware through table/column objects and helpers such as `sql.identifier(...)`. That matches this rule's target shape, but the current implementation no longer treats tag names as proof. A clean path for these APIs must be symbol/type-backed or delegated to a SQL-aware dataflow tool.

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
- `/Users/sushi/code/opencode/packages/effect-drizzle-sqlite/src` and `/Users/sushi/code/opencode/packages/core/src/database/migration.ts` stay clean for Drizzle `sql` tags and `sql.identifier(...)` composition only when the tag is proven as an import from `drizzle-orm/sql/sql` or `drizzle-orm`.
- `/Users/sushi/code/opencode/packages/stats/core/src/domain/inference.ts` stays clean for local `sqlIdentifier` / `sqlString` quote-doubling helpers, finite static `dimensionSql` fragments, and local SQL-fragment builders that only receive identifier-safe literal arguments.

Imported escaper clean:

- `/Users/sushi/code/powersync-service/modules/module-mysql/src/replication/BinLogStream.ts` line 311 stays clean because the imported `escapeMysqlTableName(table)` symbol resolves to a function whose body quote-doubles backticks in schema and table names before returning an identifier fragment.

Current benchmark result after placeholder-list, numbered Postgres placeholder-fragment, static-fragment, closed-identifier, constructor-validated identifier narrowing, and type-aware PowerSync plans:

- 370 checked files.
- 0 parser errors.
- 145 `antidrift/no-sql-string-concat` findings.
- 0 `sonarjs/sql-queries` findings.
- PowerSync service contributes one raw-table finding and zero findings for imported escaper, configured escaped-identifier, numbered-placeholder, and `AbstractPostgresConnection.sql` clean controls under type-aware plans.

Earlier widened local scan, superseded by the finite source-fleet gate:

- A fresh ad hoc SQL-pattern scan across `/Users/sushi/code`, excluding the antidrift repo and Chaski roots, checked 1,024 candidate files with this rule.
- It reported 168 findings and 0 parser errors.
- Sudocode's typed `ORDER BY ${sortBy} ${order}` service code now stays clean, as does the matching integration helper.
- External corpus still proves configured Drizzle imports, Cloudflare core `Agent.sql`, and PowerSync `AbstractPostgresConnection.sql` clean through import or declaration-source provenance. Broad source-fleet scans no longer trust name lookalikes, so unclassified SQL-builder/tagged-template findings stay visible as inventory until each builder has equivalent proof.
- The named Sudocode/Cloudflare findings are classified: dynamic `Object.keys(updates)` update helpers and the playground table-name query are drift; browser/test payload SQL-looking strings and constructor-validated namespace table identifiers are clean. Many other findings are duplicate Chaski-derived local roots or unclassified builder inventory, so they do not provide independent stable-promotion replication.
- The scan is now reproducible through `pnpm policy:inventory-sql-broad`. The finite source-fleet gate is `pnpm policy:inventory-sql-source-fleet`: 24 primary source repos, excluding worktrees, remediation copies, baseline copies, scratch folders, and generated artifacts. The current source-fleet run checked 1,378 SQL-candidate files, reported 486 custom findings, reported 0 SonarJS findings, and had 0 parser errors after name-only SQL member proof was removed.
- The source-fleet run confirmed the parser-services boundary: escaped identifier controls such as `table.escapedIdentifier` and `escapeMysqlTableName(table)` report unless the inventory has TypeScript parser services to resolve the getter/helper proof. It also classified and fixed the PowerSync Postgres storage false positive by proving the dynamic fragment interpolates only generated `$<number>` placeholders while all values remain bound in `params`.
- The widened source-fleet run also found and fixed one non-SQL false positive in `figma-console-mcp`: a Figma JavaScript payload string containing `COMPONENT_SET` and `const config = ${...}`. Operator-position interpolation now requires nearby SQL statement context, so ordinary code payloads with words like "select" and "from" do not become SQL sinks.

Current source-fleet finding classification:

| Class | Count | Examples | Handling |
|---|---:|---|---|
| Production drift | 1 | PowerSync `MySQLRouteAPIAdapter.ts:235` raw `sourceTable.table` interpolation | Keep reporting. |
| Parser-services-only conservative reports | 3 | PowerSync `BinLogStream.ts:311`, `WalStream.ts:437`, `replication-utils.ts:290` | Clean in type-aware plans; do not add name-only exemptions. |
| Lower-strength demo/test drift | 27 | Cloudflare demo `SqlDemo.tsx:133`, Sudocode dynamic test update helpers, PowerSync integration-test SQL interpolation | Keep as pressure evidence, not stable-production evidence. |
| Known false positives after this slice | 2 | Cloudflare Voice and AI Chat Agent.sql tags blocked by unresolved external package tsconfigs | Keep the rule off in the shipped config until those member proofs can run type-aware without local shims, then rerun source-fleet/adversarial review. |

## Promotion State

Status: `false-positive-prone`, `stable: false`, default-off inventory.

The observed SQL interpolation and identifier-proof surface remains useful inventory, but it is not ready for blocking severity while two real SQL-builder clean controls remain parked behind external type-service availability. Production drift exists in Chaski HogQL/template interpolation and PowerSync raw `sourceTable.table` interpolation. The second independent sanitized identifier clean-control gap is resolved: Cloudflare Workspace covers anchored-regex/early-exit identifier derivation, and Opencode stats covers quote-doubling identifier and string escapers plus bounded local SQL-fragment builders. PowerSync service supplies the lower-edge pressure case: raw table access reports next to escaped table-name APIs, imported `escapeMysqlTableName(table)` stays clean through TypeScript symbol-to-declaration proof, Postgres `SourceTable.escapedIdentifier` stays clean only through an explicit type/member contract that requires parser services, numbered placeholder fragments stay clean through local structure, and `AbstractPostgresConnection.sql` stays clean through configured member declaration-source provenance.

Accepted inventory evidence:

- Chaski and PowerSync service provide independent production drift.
- Chaski, Codebase Atlas, Sudocode, Cloudflare, Opencode, and PowerSync service supply clean and pressure controls for placeholder lists, static SQL fragments, SQL tag ecosystems, ORM-owned SQL composition, closed identifier/direction fragments, serialized payload data, constructor-validated identifiers, local and imported quote escapers, finite static object fragments, numbered placeholder fragments, configured SQL builder tags/members, and bound values.
- `pnpm policy:benchmark-sql-queries` currently checks 370 files, reports 145 custom findings, 0 SonarJS findings, and 0 parser errors. The tagged-template inventory is high-noise classification work, not an allowlist.
- `pnpm policy:inventory-sql-source-fleet` currently checks 1,378 SQL-candidate files across 24 primary source repos, reports 486 custom findings, 0 SonarJS findings, and 0 parser errors after name-only SQL member proof was removed.
- `pnpm policy:validate-external-corpus` now proves the configured Drizzle, Cloudflare core Agent, and PowerSync SQL-builder clean controls; it is still not a stable-promotion proof while Cloudflare Voice and AI Chat member proofs are blocked by external tsconfig resolution.
- The June 9 adversarial cleanup keeps the placeholder proof limited to `+` and `*` index arithmetic and restores short-circuit safety checks.

Accepted boundaries before stable promotion:

- Source-fleet membership is fixed for the current promotion. New primary source repos require a fresh inventory slice; worktrees, copied remediation repos, generated bundles, and scratch folders do not count.
- Test/demo drift remains lower-strength pressure. The production drift evidence is Chaski plus PowerSync.
- Non-type-aware inventory cannot prove imported escapers or configured safe identifier members by design. The codified policy is that extra-only non-type-aware reports are conservative inventory, while missing non-type-aware findings or parser errors block promotion.
- SQL tag ecosystems are proof boundaries, not allowlists. Cloudflare Voice/AI Chat Agent.sql, Prisma `$queryRaw`, Kysely, Slonik, and aliased tags still need real import or declaration-source proof before any tag-specific clean path is added.
- Member-tag `source` config must be path-qualified; bare suffixes such as `index.ts` are rejected so declaration-source proof cannot trust unrelated same-named files.
- Positive guard, allowlist, quantifier, and regex-variant SQL identifier sanitizers remain monitored expansion boundaries. The current benchmark finds the supported negative regex/exit shape and one clean quantifier branch.
- Unsafe dynamic SQL-builder `+=`, `.concat()`, and array-join examples have not been found. Do not widen builder linting without a real unsafe program.
- Placeholder arithmetic beyond index `+`/`*` numeric expressions remains unsupported until real clean code proves it.

The June 8, 2026 advisory review was grounded in repo reads and treated the implementation as locally sound, not stable. The June 9, 2026 advisory review (`reports/claude-rule-review-no-sql-string-concat-20260609-0803-rerun.md`) found the PowerSync imported-escaper proof sound, but held stable promotion on parser-service policy. The June 18, 2026 registry sweep supersedes that earlier local-soundness classification: the rule is now `false-positive-prone`, default-off inventory until Cloudflare Voice/AI Chat `Agent.sql` and any other SQL-builder/tagged-template clean controls have import or declaration-source proof instead of name trust or tsconfig shims. That policy is codified through `parserServiceDeltas`, and the safe-template provenance slice keeps the same boundary: configured imported tags can be proven through import binding; configured member tags require parser services plus declaration-source ownership. Safe identifier/member controls remain parser-services-only; do not add name-only exemptions or local tsconfig shims to make non-type-aware inventory quiet.
