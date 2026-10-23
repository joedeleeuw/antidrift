# `antidrift/no-redundant-zod-parse`

## Definition

Validation belongs at the boundary where raw input first enters the program. Re-validating a value with the schema that already produced it — or that its declared contract already states it is — adds no proof and hides the real architecture question: where is the boundary?

The rule reports three shapes at a schema validation call site:

- re-parsing a value this file already produced from the same schema;
- parsing a parameter the caller declared as the schema output, which coerces a contract the caller satisfied by construction;
- reshaping a payload inline inside the parse call instead of decoding the raw value.

## Signal

This is a TypeChecker ESLint rule. It runs on `defineTypeScriptRule` ([`ts-rule-kernel.mjs`](../../tooling/antidrift/src/semantic-adapters/ts-rule-kernel.mjs)) and takes schema recognition and provenance from [`schema-provenance.mjs`](../../tooling/antidrift/src/semantic-adapters/schema-provenance.mjs); the inline-reshape branch shares [`bag-projection.mjs`](../../tooling/antidrift/src/semantic-adapters/bag-projection.mjs) with `antidrift/no-bag-reshaper`.

`schemaValidationCallParts` recognises a validation call by resolving the callee symbol to its package: Zod (`parse`, `parseAsync`, `safeParse`, `safeParseAsync`), Effect Schema (curried `Schema.decodeUnknownSync(S)(value)` and two-argument `Schema.decodeUnknownSync(S, value)`), Valibot (`parse`, `safeParse`), and TypeBox (`Decode`, `Parse`, `Check`). A call that is the direct expression of an `expect(() => ...).toThrow()` / `not.toThrow()` callback is skipped: that asserts a schema contract rather than validating a value.

Provenance then comes from TypeScript symbols, never from argument types:

- **Same-binding.** `const parsed = S.parse(raw)` (including an `await`ed call and the `safeParse` result) is recorded against the parsed value's symbol. A later validation call on the same schema symbol reports `Redundant Zod parse`.
- **Declared schema-output parameter.** When the argument resolves to a parameter whose declared type — directly or through one type alias — is `z.infer<typeof S>`, `z.output`, `z.TypeOf`, `typeof S.Type`, `Schema.Schema.Type<typeof S>`, `InferOutput<typeof S>`, or `Static`/`StaticDecode<typeof S>` for the same schema `S`, the rule reports `Parse as cast`. Next.js server actions are exempt: a function exported from a module with a top-level `"use server"` directive, or carrying the directive in its own body, is a network endpoint whose declared parameter type the client never satisfied.
- **Inline reshape.** In non-test files, `S.parse({ ... })` whose properties all project from one root source reports `inlineObjectReshape`, and `S.parse(cond ? { ... } : value)` over a pure condition on that source reports `inlineConditionalReshape`.

Schema identity is TypeScript symbol identity: import aliases are followed, and one object-property assignment is followed so a schema held as a contract property (`contract.method.resultSchema`) resolves to the binding it was initialised from. Two different symbols never unify, so a local mirror of an imported contract does not match the import. Test files keep only the same-binding shape; the parameter and inline-reshape shapes are schema-contract checks there.

## Rejected Signal: Type Equivalence

Helper and service call results. `S.parse(await getTypedValue())` was once gated on bidirectional assignability between the helper's declared return type and the schema output. It was removed on 2026-08-10 because refinements (`.min`, `.positive`, `.refine`, `.transform`) are invisible to the type system, so `NonEmpty.parse(readName())` with `readName(): string` false-positived. Type equivalence is not decoder provenance: the value must be proven to have come from this decoder. That leaves two accepted limits — a helper/service call result stays clean until decoder producer provenance exists, and a nested pipeline such as `OutputSchema.parse(CoercionSchema.parse(raw))` stays clean because the inner parse is a first-boundary step.

## Should Flag

```ts
const parsed = RowSchema.parse(raw);
const again = RowSchema.parse(parsed);
```

Why: the second parse is the same schema validating its own output.

```ts
function submit(request: z.infer<typeof submitRequestSchema>) {
  const parsed = submitRequestSchema.parse(request);
}
```

Why: the declared contract already states `request` is schema output; the parse turns a compile-time contract into a runtime failure inside the callee.

```ts
return submitRequestSchema.parse({
  taskId: row.taskId,
  title: row.title,
});
```

Why: the payload is reshaped inline to satisfy the schema. Define a named boundary decoder at the receiving adapter and parse once.

## Should Not Flag

```ts
const row = RowSchema.parse(raw);
```

Why: raw input is crossing a validation boundary for the first time.

```ts
const registry = RegistrySchema.safeParse(JSON.parse(raw));
```

Why: file contents are raw JSON and still need a boundary parse.

```ts
"use server";
export async function submit(request: z.infer<typeof submitRequestSchema>) {
  return submitRequestSchema.parse(request);
}
```

Why: a server action is a network endpoint; its declared parameter type is not a caller guarantee.

```ts
expect(() => ManifestSchema.parse(manifest)).not.toThrow();
```

Why: a schema-contract assertion. The parse result is not passed back into application code; the test proves a generated or assembled value still satisfies the runtime schema.

## Real Corpus Evidence

Drift in a private app, 2 findings:

- A router re-parses data-warehouse gateway rows already typed as the schema's output.
- The same file parses flattened analytics gateway rows, also already typed as the schema's output.

Private-app clean controls: the data-warehouse gateway parses and coerces rows at the boundary, a service module validates external gRPC responses, and another router validates locally assembled records.

Clean in a second private app: a service module constructs schema-owned values, and two test files are schema-contract assertions. Deliberately clean (`under-proven`): one module parses a plain `string` parameter with a refinement-carrying schema (`z.string().min(1)`), a real runtime check, and another parses a `z.input<typeof S>` parameter, the pre-validation contract.

Clean in a third private app: an API server module normalises raw registry JSON at the boundary. That app's drift for the declared-parameter shape this rule absorbed is inventoried in [`no-parse-as-cast.md`](no-parse-as-cast.md).

Broad inventory (June 4, 2026, same-binding provenance):

- The second private app's `src`: the 6 test-file findings are clean inside `expect(() => Schema.parse(value)).not.toThrow()` schema-contract assertions.
- A fourth private app's `src`: 2 parse-candidate files, 0 findings.
- Sudocode server/CLI: 46 parse-candidate files, 0 findings.
- The third private app's shared, client, and asset pipeline: 18 parse-candidate files, 0 findings.

## Scope Decision

Tests that assert a generated product still satisfies a schema are legitimate schema-contract tests even when the value is statically typed. The rule uses an assertion-context exception, not a test-file override: a parse is ignored only when it is the direct expression checked by a function passed to `expect(...)` with a throw matcher such as `toThrow` or `not.toThrow`. A redundant parse in a test still reports when its result is assigned, returned, or otherwise consumed.

Claude advisory review on June 4, 2026 (`reports/claude-rule-review-no-redundant-zod-parse-20260604-170153.md`) agreed the exception is the right shape and asked for a real negative gate for consumed assertion-callback parses or an explicit acceptance that the corpus lacks that edge. A follow-up scan over 50 test files in the second private app, 30 in the third private app's API, 132 in the Sudocode server and 11 in the first private app's backend found no consumed assertion-callback reparse; all stayed clean. The edge is accepted as unrepresented in the corpus rather than blocked on a synthetic fixture.

## Ecosystem Check

No maintained ESLint/Zod rule tracks schema provenance and reports "the same schema parses its own output". Generic TypeScript safety rules (`no-unsafe-assignment`, `no-unsafe-return`) and generic Zod style rules do not distinguish raw input from schema-owned output. The public rules of this name in `dfine-io/dlint` are type-shape detectors — the mechanism this package retired — so their exemptions do not transfer, though two hold structurally and the implementation covers them: `S.catch(x).parse(v)` is a different schema instance reached through a call, and a throw-assertion callback asserts the schema itself.
