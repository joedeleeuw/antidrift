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

## Ecosystem Check

No supported ESLint/Zod rule has been found that tracks schema provenance and reports "same schema parses its own output." Generic TypeScript safety rules (`no-unsafe-assignment`, `no-unsafe-return`) and generic Zod style rules do not distinguish raw input from schema-owned output.

State: `net-antidrift`.

## Real Corpus Evidence

Chaski drift:

- `/Users/sushi/code/chaski/src/frontend/bff/api/routers/retool/sequence-count-router.ts` line 21 re-parses BigQuery gateway rows already typed as `CountSequenceRow[]`.

Murderbox production drift:

- `/Users/sushi/code/murderbox/apps/api/app/api/machines/setup/route.ts` line 27 parses `setupMachine(...)` output even though `setupMachine()` returns `Promise<MachineSetupResponse>`.

Clean controls:

- `/Users/sushi/code/chaski/src/frontend/bff/api/gateways/bigquery-gateway.ts` performs first-boundary parsing and coercion of BigQuery rows.
- `/Users/sushi/code/chaski/src/frontend/bff/api/services/scenarios-service.ts` validates external gRPC responses.
- `/Users/sushi/code/chaski/src/frontend/bff/api/routers/retool/erp-router.ts` validates locally assembled ERP records.
- `/Users/sushi/code/codebase-atlas/src/services/generatedStateIntegrityService.ts` constructs schema-owned manifest/report values.
- `/Users/sushi/code/murderbox/apps/api/lib/server/workspace-projects.ts` normalizes raw registry JSON at the boundary.

Broad inventory:

- Codebase Atlas `src`: 61 parse-candidate files, 6 findings, all in `src/test/**`.
- Taskme `src`: 2 parse-candidate files, 0 findings.
- Sudocode server/CLI: 46 parse-candidate files, 0 findings.
- Murderbox API: 32 parse-candidate files, 1 production finding.
- Murderbox shared, client, and asset pipeline: 18 parse-candidate files, 0 findings.

## Current Concern

The Codebase Atlas findings are in tests that assert a generated product still satisfies a schema. That can be legitimate schema-contract testing even when the value is statically typed. Stable promotion needs one of:

- a test-file override,
- an assertion-context exception, or
- an explicit decision that typed schema-contract reparses in tests are still drift.

Until that is decided, the rule remains `stable: false`.
