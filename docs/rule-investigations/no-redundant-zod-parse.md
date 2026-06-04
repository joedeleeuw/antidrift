# `antidrift/no-redundant-zod-parse`

## Problem

Agents often make a typed value feel safer by parsing it again with the same Zod schema that already produced the type. That hides the real architecture question: where is the validation boundary?

This rule should catch repeated validation after a value is already known to be the schema output. It should not catch first-boundary parsing of raw input, file contents, network responses, database rows, or deliberately assembled objects whose runtime shape is still being established.

## Signal

Type-aware Zod provenance.

The rule confirms that `.parse()` / `.parseAsync()` is a Zod method through TypeScript symbol declarations, not by name. It then reports either:

- a value already recorded as produced by the same schema, or
- an awaited service/helper result whose type is equivalent to the schema output.

## Should Flag

```ts
const result = await setupMachine(machineId);
return Response.json(machineSetupResponseSchema.parse(result));
```

Why: `setupMachine()` already returns `Promise<MachineSetupResponse>`, and `MachineSetupResponse` is the inferred output of `machineSetupResponseSchema`.

```ts
const parsed = RowSchema.parse(raw);
const again = RowSchema.parse(parsed);
```

Why: the second parse is the same schema validating its own output.

## Should Not Flag

```ts
const row = RowSchema.parse(raw);
```

Why: raw input is crossing a validation boundary for the first time.

```ts
const registry = workspaceProjectRegistrySchema.safeParse(JSON.parse(raw));
```

Why: file contents are raw JSON and still need a boundary parse.

```ts
const manifest = GeneratedStateManifestSchema.parse({
  schemaVersion: 1,
  source,
  generated,
});
```

Why: the function is constructing a schema-owned output object.

```ts
expect(() => GeneratedStateManifestSchema.parse(manifest)).not.toThrow();
```

Why: this is a schema-contract assertion. The parse result is not passed back into application code; the test is proving that a generated or assembled typed value still satisfies the runtime schema.

## Ecosystem Check

No supported ESLint/Zod rule has been found that tracks schema provenance and reports "same schema parses its own output." Generic TypeScript safety rules (`no-unsafe-assignment`, `no-unsafe-return`) and generic Zod style rules do not distinguish raw input from schema-owned output.

State: `net-antidrift`.

## Real Corpus Evidence

Chaski drift:

- `/Users/sushi/code/chaski/src/frontend/bff/api/routers/retool/sequence-count-router.ts` line 21 re-parses BigQuery gateway rows already typed as `CountSequenceRow[]`.
- `/Users/sushi/code/chaski/src/frontend/bff/api/routers/retool/sequence-count-router.ts` line 26 directly parses flattened PostHog gateway rows already typed as `HogQLRow[]`.

Murderbox production drift:

- `/Users/sushi/code/murderbox/apps/api/app/api/machines/setup/route.ts` line 27 parses `setupMachine(...)` output even though `setupMachine()` returns `Promise<MachineSetupResponse>`.

Clean controls:

- `/Users/sushi/code/chaski/src/frontend/bff/api/gateways/bigquery-gateway.ts` performs first-boundary parsing and coercion of BigQuery rows.
- `/Users/sushi/code/chaski/src/frontend/bff/api/services/scenarios-service.ts` validates external gRPC responses.
- `/Users/sushi/code/chaski/src/frontend/bff/api/routers/retool/erp-router.ts` validates locally assembled ERP records.
- `/Users/sushi/code/codebase-atlas/src/services/generatedStateIntegrityService.ts` constructs schema-owned manifest/report values.
- `/Users/sushi/code/murderbox/apps/api/lib/server/workspace-projects.ts` normalizes raw registry JSON at the boundary.

Broad inventory:

- Codebase Atlas `src`: the prior 6 test-file findings are now clean when they appear inside `expect(() => Schema.parse(value)).not.toThrow()` schema-contract assertions.
- Taskme `src`: 2 parse-candidate files, 0 findings.
- Sudocode server/CLI: 46 parse-candidate files, 0 findings.
- Murderbox API: 32 parse-candidate files, 1 production finding.
- Murderbox shared, client, and asset pipeline: 18 parse-candidate files, 0 findings.

## Scope Decision

The Codebase Atlas findings were in tests that assert a generated product still satisfies a schema. That is legitimate schema-contract testing even when the value is statically typed.

The rule now uses an assertion-context exception, not a test-file override. A Zod parse is ignored only when it is the direct expression checked by a function passed to `expect(...)` and that expectation uses a throw matcher such as `toThrow` or `not.toThrow`. A redundant parse in a test still reports if the parsed result is assigned, returned, or otherwise consumed as a value.

Claude Opus 4.8 advisory review completed on June 4, 2026 (`reports/claude-rule-review-no-redundant-zod-parse-20260604-170153.md`). It agreed the assertion-context exception is the right shape and asked for either a real negative gate for consumed assertion-callback parses or an explicit acceptance that current corpora do not contain that edge.

Follow-up real-corpus search on June 4, 2026 found no consumed assertion-callback reparse case to promote as a drift gate. The scan ran the narrowed rule over 50 Codebase Atlas test files, 30 Murderbox API test files, 132 Sudocode server test files, and 11 Chaski BFF test files; all stayed clean. The consumed-parse edge is accepted as unrepresented in the current corpus rather than blocked on a synthetic fixture. The implementation still keeps the exception narrow by requiring the parse call to be the direct throw-assertion expression.

The later helper-result slice closed the remaining promotion blocker: direct awaited or synchronous helper calls such as `Schema.parse(await getTypedValue())` and `Schema.parse(getTypedValue())` now report when TypeScript proves the helper result is already equivalent to the schema output, while nested schema pipelines remain clean.

Known remaining limits:

- Inline service reparses such as `Schema.parse(await getTypedValue())` and synchronous helper reparses such as `Schema.parse(getTypedValue())` are caught when TypeScript proves the call result is equivalent to the schema output.
- Nested schema pipelines such as `OutputSchema.parse(CoercionSchema.parse(raw))` stay clean because the inner parse is a first-boundary validation step, not a typed service result.
- The service-result branch trusts TypeScript annotations. If a helper is typed as a schema output but internally casts raw data without validation, a first real boundary parse can look redundant.

## Promotion State

Status: `ready`, `stable: true`.
