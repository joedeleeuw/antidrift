# no-parse-as-cast Investigation

Status: `ready`, enabled at error in the ESLint config. Next.js server actions (exported from a `"use server"` module, or carrying the directive in their body) are exempt: they are network endpoints. On a 54-repository corpus the rule reports 15 findings in 5 repositories, all true positives.

## Problem Statement

A parameter is declared as the output of a Zod schema, and the function body immediately parses it with that same schema:

```ts
type SubmitRequest = z.infer<typeof submitRequestSchema>;

async submit(request: SubmitRequest) {
  const parsed = submitRequestSchema.parse(request);
}
```

The declared contract already states the caller supplied a validated value. The parse therefore validates nothing the compiler has not already proven; it coerces a contract the caller satisfied by construction. Zod strips unknown keys and throws on refinement failures, so the call is not a no-op — it silently reshapes data and converts a compile-time contract into a runtime failure inside the callee.

This is the sibling of `antidrift/no-redundant-zod-parse`. That rule proves provenance from a local `Schema.parse()` result or a repo-local call result. This one proves provenance from the parameter's declared type, which is the case the existing rule structurally cannot see — `fixtures/programs/drift/zod-reparse-typed-value.ts` was already listed as a known-uncovered case in its own suite.

## Signal

Reported when all of these hold:

1. The call is a Zod `parse`/`parseAsync` (existing `zodParseCallParts` detection, which resolves the method symbol to the `zod` package).
2. The argument is a plain identifier.
3. The identifier resolves to a function parameter with an explicit type annotation.
4. That annotation resolves to a type alias whose right-hand side is `z.infer<typeof S>` / `z.output<typeof S>` / `z.TypeOf<typeof S>`.
5. `S` resolves to the same symbol as the schema receiving the `.parse` call, after import-alias resolution, and after following a single object-property assignment so contract objects (`contract.method.resultSchema`) resolve to the underlying schema binding.

Not reported: `expect(() => S.parse(x)).toThrow()` callbacks, via the existing throw-assertion exemption.

## Rejected Signal: Structural Type Identity

The first implementation reused `parsedCallResultMatchesSchemaOutput` — mutual assignability between the argument type and the parse return type. It produced 6/6 true positives in a private app but 3 false positives out of 4 findings in another private app:

| Site                  | Why it is clean                                                                                                       |
| --------------------- | --------------------------------------------------------------------------------------------------------------------- |
| A source module       | Schema is `z.string().min(1)`; the parameter is `string`. Types are identical, but `.min(1)` is a real runtime check. |
| Another source module | Parameter is `z.input<typeof S>` — deliberately the pre-validation contract — and the schema is `.strict()`.          |
| A test file           | Test contract oracle asserting an adapter emits schema-valid output.                                                  |

The lesson is general: **TypeScript type identity is not a proxy for "this parse validates nothing new."** Zod refinements (`.min`, `.int`, `.nonnegative`, `.regex`), `.strict()`, and `z.input`/`z.output` divergence are all invisible to the type system. Only derivation provenance — this type came from this schema — supports the claim.

## Real-Corpus Results

Provenance signal, run against full repositories with type services.

The first private app's desktop client, 38 files, **6 findings, 0 known false positives**:

- one parameter in one source module
- two parameters in a second source module
- two parameters in a third source module
- one parameter in a fourth source module

The clearest anchor is a request parameter whose caller already parsed the request with the same request schema before calling in, so the inner parse is a second validation of the same value. This is the exact invariant `no-redundant-zod-parse` states in its own message — validate once at the boundary and pass the parsed value inward.

The other private app, 81 Zod-using files, **5 findings, all one contested shape**:

- two in a projection module
- two in a service module
- one in a test file

## Open Decision

The other private app's findings share a shape the first app's do not: each parameter name ends in `Input` and the enclosing function is named `validate*`. The authors clearly intended defensive re-validation at a module boundary. The type says the value is already valid; the name says it is not. The rule reports the contradiction, but whether the contradiction is drift is a policy question, not a technical one.

Two coherent positions:

- **Drift.** The fix is to type the parameter as the unvalidated input (`unknown`, or `z.input<typeof S>`) so the parse is honest. This is consistent with the first private app's reading and with `no-redundant-zod-parse`.
- **Accepted practice.** Defensive parses at module boundaries are a deliberate belt-and-braces stance, and the rule should exempt them — plausibly by exempting functions whose parameter is annotated `z.input` only, which would require the other private app's code to change anyway.

That service module is registered in `external-corpus/cases.mjs` as a clean control for `no-redundant-zod-parse`. That case remains valid — it is clean for that rule — but the file is not clean for this one, and reviewers should not read the existing entry as clearing it here.

## Promotion Gate

1. The contested class from the other private app is decided and recorded here.
2. A test-context exemption is implemented, or test oracles are accepted as reportable with rationale.
3. A second repository supplies uncontested positives of the first private app's kind (boundary already parsed upstream).
4. A real remediation lands and demonstrably improves the code.
5. Known false positives are zero under the chosen scope.

## Reusable Mechanism

The schema-derivation trace — resolve a declared type alias back to the schema it was derived from, then compare that schema symbol against the one in play — is not specific to this rule. It also backs:

- an `unknown`-erasure rule (`const result: unknown = typedCall()` immediately before a parse, observed at three sites in the first private app's desktop client), which currently defeats `no-redundant-zod-parse` because the declared type is `unknown`
- hand-written interfaces that fork a `z.infer` alias, for the structural-fork family
- contract-projection detection where a projection's target type descends from a schema

If a second rule needs it, lift the helpers out of `rules/no-parse-as-cast.js` into `semantic-adapters/schema-provenance.mjs` alongside the existing provenance helpers.
