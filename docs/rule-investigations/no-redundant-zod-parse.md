# `antidrift/no-redundant-zod-parse`

## Problem

Agents often make a typed value feel safer by parsing it again with the same Zod schema that already produced the type. That hides the real architecture question: where is the validation boundary?

This rule should catch repeated validation after a value is already known to be the schema output. It should not catch first-boundary parsing of raw input, file contents, network responses, database rows, or deliberately assembled objects whose runtime shape is still being established.

## Signal

Canonical-path Zod provenance. No type information is consulted anywhere.

The rule was a type-aware ESLint rule until 2026-08-13. It confirmed `.parse()` was a Zod method through TypeScript symbol declarations, and it unified the two parse sites through symbol identity — which meant the schema receiver had to be a plain identifier. That is blind to the ecosystem's dominant architecture: contract-first libraries (ts-rest, oRPC, tRPC, Hono validators) hold schemas as properties of a contract object, so the receiver is a member expression such as `contract.getPost.responses[200]` or `method.resultSchema`.

The shipped detector is in the Oxlint syntax tier and works from local AST plus scope bindings:

- **`canon(expr)`** strips chain and TS wrappers, collects member segments while they stay static (identifier properties and literal computed keys, so `responses[200]` resolves), resolves the base identifier to a scope binding, expands const aliases whose initializer is an identifier or member expression (depth-capped and cycle-guarded), and roots at the first non-alias binding. The result is ⟨root binding⟩ plus segments. Dynamic segments, calls anywhere in the chain, and unresolved globals produce no path at all. Bailing is silent by design.
- **Provenance** is recorded at `const v = P.parse(x)` (and the `parseAsync`/`safeParse`/`safeParseAsync` variants) and reported at `P'.<method>(v)` when the two canonical paths are equal, the root is a const or import that is never rebound, no prefix of the path is written anywhere in the file, and `v` is neither mutated nor escaped into a call between the two sites. The pre-migration same-binding rule is the zero-length-path case of this, so all six `zod-reparse-*` drift fixtures port unchanged.
- **safeParse provenance flows through the result object**, not only the call: `const r = S.safeParse(x)` marks `r.data` as `S`-validated output, and `const { data } = S.safeParse(x)` marks the destructured binding. This is a bounded special case for the safeParse result shape, not general field-level provenance.
- **Cross-module unification never happens by inference.** A local mirror of an imported contract schema has a different root binding, so it does not unify. Same root binding or nothing.

The helper-result branch was removed on 2026-08-10 and must not return. It gated reports on bidirectional TypeScript assignability between the helper's declared return type and the schema output, but assignability never proves the same decoder ran: refinements (`.min`, `.positive`, `.refine`, `.transform`) are invisible to the type system, so `NonEmpty.parse(readName())` with `readName(): string` false-positived. Type equivalence is not decoder provenance — and the two public rules that share this rule's name are exactly that retired mechanism.

## Schema-ness without types

The method-name set (`parse`, `parseAsync`, `safeParse`, `safeParseAsync`) is only the trigger. Without a checker, the rule needs positive evidence that the receiver names a schema, because `JSON.parse`, `path.parse`, and document parsers share the method name. The classification, in order:

1. If the path's root binding is an import, classify by module specifier: the zod family (configurable through `schemaModules`) is `zod-rooted`; a specifier in `contractModules` is `declared-container`; `node:` builtins and anything in `nonSchemaModules` are vetoed; everything else is `opaque-container`.
2. Otherwise resolve the path in-file — descending object literals, array literals, and the object argument of a builder call so `c.router({ getPost: { responses: { 200: PostSchema } } })` resolves — and classify the base identifier of whatever expression the path lands on by the same module rules.
3. An unresolved or global root (`JSON`, `Date`) is never a schema.

The default `nonSchemaModules` list is the one heuristic in the rule, and it is a bounded, explicit, configurable list rather than a proof. Its residual false-positive shape is a same-file double parse through a member of a first-party or unlisted module that happens to expose a `parse` method; `nonSchemaModules` exists to silence exactly that.

## Exemptions re-derived

`dfine-io/dlint` ships a rule with this name whose detector is type-shape, and its four exemptions exist to suppress failure modes that shape-matching creates. Each was re-derived against the provenance gate:

| Exemption | Verdict | Reasoning |
| --- | --- | --- |
| safeParse is always a boundary | Rejected | A shape detector cannot tell a defensive check of untrusted input from a re-check of its own output, so it must exempt the method wholesale. Under provenance, a defensive check of unknown input never reaches the gate, and `S.safeParse(ownOutput)` cannot fail — it is dead code, so it gets its own `alwaysSuccessfulSafeParse` message instead of an exemption. |
| `.catch()` / `.default()` chain | Kept structurally | `S.catch(x).parse(v)` puts a call in the receiver chain, so `canon` produces no path. It is also a different schema instance, so unifying it would have been wrong. No exemption code exists. |
| `"use server"` files | Rejected | It exists because a server action's typed parameters are untrusted at runtime, which only matters to a detector reading the parameter's type. A boundary parse of an argument never reaches the gate; a file that parses the same value twice is drift wherever it runs. |
| Widely-typed veto (`any`/`unknown`) | Rejected | It is a checker query this tier does not have, and it is unnecessary: it protects against a declared type that lies about the runtime value, while the gate requires the literal result of this schema's own parse call. |
| Throw-assertion callbacks | Kept | Carried over from the pre-migration rule. `expect(() => S.parse(v)).toThrow()` asserts a schema contract, not validation drift, and provenance cannot distinguish it. |

## Real-corpus validation (2026-08-13, canonical-path engine)

Measured by running the shipped Oxlint plugin over seven trees with only this rule enabled. Every clone was shallow and read-only.

| Repository | Files linted | `parse`-family call sites | Findings | False positives |
| --- | --- | --- | --- | --- |
| murderbox (`chat-profile-resolver`, incl. `apps/client`) | 1157 | 743 (456 non-test) | 0 | 0 |
| dust-tt/dust | 9908 | 966 | 0 | 0 |
| elizaOS/eliza | 18139 | 5126 | 0 | 0 |
| hyperdxio/hyperdx | 1221 | 601 | 0 | 0 |
| pranitnale/InTown | 264 | 90 | 0 | 0 |
| ts-rest/ts-rest | 316 | 20 | 0 | 0 |
| muralibasani/streamlens | 88 | 17 | 0 | 0 |

Zero false positives on roughly 7,563 parse-family call sites, and zero true positives. The zero on both sides is the finding, not an absence of evidence — the populations that could have produced a false positive were present and stayed silent:

- **The newly gained contract seam, exercised and clean.** streamlens is scaffolded `api.<resource>.<op>.responses[<status>].parse(await res.json())` client hooks — ten member-expression receivers with literal computed keys, exactly the shape the migration adds. Every one is a boundary parse of a fetch response, and none reported.
- **Repeated identical receivers, clean.** 89 murderbox files parse the same schema two or more times in one file (up to 16×). Repetition is not redundancy — each call validates a different raw value — and none reported.
- **Non-schema receivers, clean.** 106 `JSON.parse` sites in murderbox and five genuine double-`JSON.parse` sites in eliza (`packages/cloud/shared/src/lib/types/message-content.ts`, `plugins/plugin-mcp/src/service.ts`) stayed silent. `JSON` resolves to no binding, so `canon` produces no path — the module-origin veto is not even reached.
- **The confessed re-parse in hyperdx is a correct bail, twice over.** `packages/api/src/utils/zod.ts` re-parses inside a `.transform` with the comment "Safe to call `.parse()` here — superRefine already validated the data". The receiver is a const initialized from a conditional expression, so there is no static canonical path; and the value is the transform callback's parameter, so there is no in-file provenance. Reproduced on a reduced probe. It is also arguably not drift: the re-parse selects a sub-schema to strip unknown fields, which does real work.
- **Text-level candidates that scope resolution correctly rejects.** A loose textual scan over all seven trees produced 39 provenance-shaped candidates. All but one are `JSON.parse` boundary decodes feeding a schema parse, or a scoping artifact — `dust/front/lib/api/triggers/built-in-webhooks/linear/linear_client.ts` binds `const webhook = LinearWebhookSchema.parse(...)` at line 169 and an unrelated arrow parameter named `webhook` at line 237. Text matching unifies those two names; scope resolution does not.

### The one true positive in the corpus is out of scope by design

`apps/desktop/src/bridge.ts:23` re-parses a value the same schema already produced:

```ts
import { murderboxDesktopBridgeContract, murderboxDesktopRuntimeInfoResultSchema } from "@murderbox/shared/desktop-bridge";
const method = murderboxDesktopBridgeContract.getRuntimeInfo;
const parsedRuntimeInfo = murderboxDesktopRuntimeInfoResultSchema.parse(runtimeInfo);
return method.resultSchema.parse(parsedRuntimeInfo);
```

`murderboxDesktopBridgeContract.getRuntimeInfo.resultSchema` **is** `murderboxDesktopRuntimeInfoResultSchema` — but only the imported module says so. The two receivers root at two different import bindings, and proving they name one object means reading another module, which the syntax tier cannot do. This is the documented "same root binding or nothing" boundary, and it is a measured false negative rather than a bug.

A relaxation was implemented and measured before being rejected: unify two roots when both are import bindings from the *same module specifier*. Across all seven trees it produced exactly one finding — this one — and no new false positives. It was still rejected, because it is unsound in a shape that is trivially constructible even though this corpus does not contain it: `import { RequestSchema, contract } from "./contract"` would unify `RequestSchema` with `contract.route.responseSchema`, which are different schemas. The measurement is evidence for the *sound* version of the capability, not for this one.

The honest reading of the whole corpus: in-file same-root re-validation is rare, and the shape that actually occurs is cross-module contract identity. Recall for this rule lives in a registry-declared or module-graph fact, which is the recorded follow-up.

## Known holes

Documented rather than solved, because both need module-graph facts the syntax tier does not have:

- a path segment backed by a getter that returns a fresh object per read, so two reads of the same path are not the same schema instance;
- cross-module mutation of an exported contract object.

Cross-owner reporting for a generated mirror of a canonical contract is deliberate follow-up scope, not a hole: canonical paths are never unified across module boundaries by inference, so a registry-gated cross-owner message would have to come from declared facts.

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

The helper-result slice that closed the promotion blocker was later found unsound and removed on 2026-08-10: `Schema.parse(await getTypedValue())` and `Schema.parse(getTypedValue())` gated on type equivalence, which cannot prove the same decoder ran (refinements are invisible to TypeScript). The slice may return only with real producer provenance in the schema-provenance adapter.

Known remaining limits:

- Helper/service call results are silent until decoder producer provenance exists; type equivalence is a rejected signal.
- Nested schema pipelines such as `OutputSchema.parse(CoercionSchema.parse(raw))` stay clean because the inner parse is a first-boundary validation step, not a typed service result.

## Promotion State

Status: `ready`, `stable: true`.
