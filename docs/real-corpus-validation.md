# Real Corpus Validation

Reduced fixture programs are legacy regression aids only. They are not proof that antidrift catches real agent failure modes, and they are not completion gates. A rule becomes **ready** only after it has an explicit real-source assertion against a local corpus file.

Clean-only corpus assertions are still useful: they protect against known real false positives, but the rule stays **under-proven** until a real drift file is also asserted.

Deleting or reclassifying tracked drift evidence is `[policy-change]` work. Refresh moved paths and line anchors from live files; delete a case only when repository history proves the drift was remediated or removed.

## Private App Corpus

The primary corpus was a private app. Its evidence came from a private-app corpus run that is no longer in the repository; the recorded results remain in this document and the rule investigations.

## Local External Research

Run one named corpus at a time:

```bash
pnpm policy:research-external-corpus -- --corpus <name>
```

This command is for research when the primary corpus has only clean controls for an implemented rule. It is not a release or session gate: external checkouts move independently, their TypeScript programs can be large, and their paths are not part of this package's reproducible source. It currently discovers these optional real repositories:

| Corpus              | Discovery                                                        | Current purpose                                                                            |
| ------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `sudocode-main`     | `SUDOCODE_REPO` or a local `sudocode-main` checkout              | Async array misuse, unsafe deserialize, Express-style authz, and hover-translate evidence. |
| Another private app | An environment variable or a local checkout                      | Type-escape-hatch, type-predicate, and typed entries clean-control evidence.               |
| A third private app | An environment variable or a local checkout                      | Redundant Zod parse evidence across API route and server boundary code.                    |
| `cloudflare-agents` | `CLOUDFLARE_AGENTS_REPO` or a local `cloudflare-agents` checkout | SQL/fetch/effect controls plus known-gap deserialize and sanitized SQL identifier cases.   |
| `opencode`          | `OPENCODE_REPO` or a local `opencode` checkout                   | Unsafe deserialize evidence plus Drizzle SQL-tag and local SQL escaper clean controls.     |

For a promotion or slice-completion claim that needs broader evidence, run the relevant named corpora independently and retain their reports. Require a selected checkout explicitly when absence must fail:

```bash
node tooling/antidrift/research/cli.mjs external-corpus --corpus <name> --require --slice <slice-name>
```

The default-off test validator and mocked-response-body guardrails use the third private app's completed test cleanup as motivating corpus evidence, but they do not register a stale path in `external-corpus/cases.mjs`: that runner executes current source bytes, and the direct validator and mock-supplied body-oracle tests were removed. Pin a reproducible pre-cleanup source or find independent live drift before using the external-corpus gate for promotion.

If the claim specifically depends on replicated drift, require drift-bearing repositories instead of only clean/pass repositories:

```bash
node tooling/antidrift/research/cli.mjs external-corpus --all --slice <slice-name> --require --min-drift-repositories 2
```

The current gate executes ESLint against source files, so executable external evidence must be available as source bytes: a local checkout, an explicit `--repo`, or a future sparse/materialized remote fetch. GitHub URLs, commit refs, and file hashes are useful provenance, but a hash alone cannot produce rule findings or type-aware parser services.

## Upstream Unsafe Assertion Benchmark

Removed with the cast-family rules, which `typescript/no-unsafe-type-assertion` in `@joedeleeuw/typescript-tooling` replaces. The record below is kept.

This was an inventory gate, not a pass/fail lint gate. It runs `@typescript-eslint/no-unsafe-type-assertion` beside the antidrift cast-family rules over real TypeScript programs from the private app, another private app, and Sudocode, then writes `reports/unsafe-type-assertion-benchmark.json`.

Current benchmark result: 2,411 files checked, 85 `antidrift/no-appeasement-cast` findings and 1,474 upstream `@typescript-eslint/no-unsafe-type-assertion` findings. Every surviving antidrift cast-family location was also reported upstream, but upstream added a much broader assertion inventory. Treat upstream as broad assertion coverage and keep `no-appeasement-cast` as the narrower source-boundary authority rule.

## Upstream SQL Query Benchmark

Run:

```bash
pnpm policy:benchmark-sql-queries
```

This is an inventory gate, not a pass/fail lint gate. It runs `antidrift/no-sql-string-concat` over real SQL-related programs from the private app, another private app, Sudocode, Cloudflare Agents, Opencode, and PowerSync Service, then writes `reports/sql-query-benchmark.json`.

Current benchmark result: 370 files checked, 0 parser errors, and 145 `antidrift/no-sql-string-concat` findings. The durable drift anchors remain the 14 analytics-query template interpolation findings in the private app, one Cloudflare playground table-name interpolation, and one PowerSync service raw table-name interpolation. After removing name-only SQL member proof, the benchmark also exposes high-noise SQL-builder/tagged-template inventory in Cloudflare Agents, Opencode, and PowerSync plans; do not treat those extra findings as promotion evidence until they are classified against import/declaration-source builder proof. Opencode stats stays clean for local `sqlIdentifier` / `sqlString` quote-doubling helpers, finite static object fragments, and bounded local SQL-fragment builders. PowerSync service still runs MySQL, Postgres, and Postgres storage type-aware benchmark plans: imported `escapeMysqlTableName(table)` stays clean through declaration proof, `SourceTable.escapedIdentifier` stays clean only through an explicit safe-identifier member contract that requires parser services to prove the receiver type, and numbered Postgres placeholder fragments such as `$${index * 2 + n}` stay clean because the interpolated values are only placeholder numbers while actual values remain bound in `params`.

The report also includes `coverageInventory`, which records promotion boundaries without turning them into lint failures. The tagged-template inventory is now proof pressure, not an allowlist: configured Drizzle imports, Cloudflare core `Agent.sql`, and PowerSync `AbstractPostgresConnection.sql` have import/declaration-source proof, while unproven Cloudflare package SQL tags, Prisma, Kysely, Slonik, and aliases remain blocked until the same proof exists. The current inventory also sees one SQL-context negative regex/exit guard (`!VALID_NAMESPACE.test(ns)`), one clean quantifier guard, 37 static SQL-builder `+=` appends, 8 dynamic SQL-builder `+=` candidates, 11 SQL sentence templates outside the old 200-character `SELECT ... FROM` pattern, and no `.concat()` or array-join SQL candidates. The 8 dynamic builder candidates are classified clean: placeholder lists, joins of static condition fragments, or allowlisted sort/direction fragments. The widened sentence-pattern trigger now reports four long unsafe templates in the private app. The PowerSync non-type-aware probe measures the parser-services boundary directly through `parserServiceDeltas`: without type services, `modules/module-mysql/src/replication/BinLogStream.ts:311`, `modules/module-postgres/src/replication/replication-utils.ts:290`, and `modules/module-postgres/src/replication/WalStream.ts:437` are conservative extras; there are zero missing non-type-aware findings.

For broad promotion inventory, run:

```bash
pnpm policy:inventory-sql-broad
pnpm policy:inventory-sql-source-fleet
```

The broad inventory scans real repositories under a local code directory, prefilters SQL-looking source files, runs `antidrift/no-sql-string-concat`, and writes `reports/sql-broad-inventory*.json`. The source-fleet script is the finite promotion capture: 24 primary source repos, excluding worktrees, remediation copies, baseline copies, scratch folders, and generated artifacts such as `.sst` and `.open-next`.

Current source-fleet run checked 1,378 SQL-candidate files across 24 primary repositories, had 0 parser errors, and reported 486 `antidrift/no-sql-string-concat` findings. The increase is intentional fallout from removing name-only SQL member proof: the broad fleet now surfaces unclassified SQL-builder/tagged-template inventory in Cloudflare Agents, Opencode, and PowerSync instead of silently accepting type-name lookalikes. Durable drift remains the previously accepted production/test/demo anchors; the extra broad-fleet findings block promotion until classified through import/declaration-source builder proof or real unsafe-builder evidence. A Figma JavaScript payload false positive from `figma-console-mcp` was removed by requiring local SQL statement context around operator-position interpolation. The termination rule is now: rerun the source-fleet gate when primary source repos are added or removed; do not count worktrees, copied remediation repos, generated bundles, or scratch folders as promotion evidence.

## Schema Roundtrip Inventory

This inventory read only another private app's programs, so it was removed with that app's corpus plans. It was an inventory gate, not a pass/fail lint gate. It used the TypeScript checker over real programs from that app to find `Schema.parse({ ...alreadyTypedSchemaOutput, overrides })` shapes, then classified each hit as `owned-only` or `cross-source` and recorded whether the parse sat at an exported boundary.

Its broad result: 225 files from that app checked, 9 roundtrip shapes found, with 3 `owned-only` and 6 `cross-source`. The focused regression assertion covered a controller module: its move method was classified `cross-source` because it rebuilt tiles from terrain nodes and previous exploration state, while a tile-update function was classified `owned-only` and `export-boundary`. That split keeps `antidrift/no-same-schema-recertification` in research instead of turning it into a blocking rule.

## Classification

- **ready**: real drift and clean files from an application corpus are asserted, or that corpus's clean controls plus a narrowly accepted fallback corpus assert the missing real drift.
- **under-proven**: implemented, but no private-app assertion yet.
- **over-broad**: real private-app clean files report findings that are not desired.
- **false-positive-prone**: real private-app evidence shows the rule needs more context before being promoted.
- **drifting**: the rule/gate no longer matches the original antidrift intent.
- **retired**: removed from the active rule surface because real corpus evidence showed the signal was not deterministic enough.

## Next Slice Rule

For each iteration:

1. If the rule is under-proven, search an application corpus first for one drift file and one clean file.
2. If the rule is already ready, use the `promotion` and `nextAction` fields in `policy/registries/rules.yaml` to pick the next promotion candidate.
3. Add only real paths to `external-corpus`; the private-app corpus run is no longer in the repository.
4. If that corpus has only clean controls, use `external-corpus` for narrowly named fallback repo cases. Never add a private repository's paths to it.
5. When fallback evidence is used, run each named external corpus independently with `pnpm policy:research-external-corpus -- --corpus <name>`.
6. For a promotion claim that depends on replicated drift, run `node tooling/antidrift/research/cli.mjs external-corpus --all --slice <slice-name> --require --min-drift-repositories 2`.
7. Do not call the rule ready or stable from reduced programs or inline fixtures. Keep them only as local regression aids while real source behavior remains the promotion gate.
