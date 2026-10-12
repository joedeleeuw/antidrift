# unknown-input-must-be-decoded

## Intent

Decode explicitly unknown parameters and local bindings before their values enter application logic. Catch bindings are exempt, as are rejection-handler parameters and serializer-only output parameters.

## Detection

AST-only, with lexical reference resolution. Each read must be a direct decoder argument, a proved type-predicate argument, or a use dominated by a successful predicate/assertion. The rule reports once on each offending binding's unknown annotation. Unused bindings and type-only references have no unsafe reads.

Decoder names start with `decode`, `parse`, `validate`, or `safeParse`, followed by the end of the name, an uppercase letter, or an underscore. Both plain calls and noncomputed method calls qualify. These names are a syntax convention, not proof that a runtime implementation validates correctly. Calls do not narrow the original binding: use their decoded result.

Predicates require a visible `value is Type` or `asserts value is Type` signature, either locally declared or directly imported from resolvable source/declarations. Imported aliases work; re-export chains, namespace methods, and inferred signatures are not followed. Merely naming a boolean helper `isMessage` is insufficient. Optional predicate calls are not proof.

Successful if branches, conditional expressions, `&&`/`||` guards, loop tests, assertion statements, and guards whose failing branch exits can establish narrowing. Ignored boolean results cannot. Reassignments invalidate proof; mutable captures and loops with writes cannot inherit outer narrowing. Analysis is conservative across branch writes and unsupported control-flow forms. This is not a general TypeScript flow checker: inline truthiness/typeof probes do not replace decoding under this policy. Low-level decoder implementations can use explicit exemptions.

Two parameter positions recognize that `unknown` is the honest annotation there, without opening escape routes. Rejection handlers — the callback of `promise.catch(...)` and the `onRejected` argument of `promise.then(onFulfilled, onRejected)`, whether written inline or passed by name when the name's reads are all rejection positions — receive the rejection reason, which has no decodable contract; the fulfillment handler of `then` is not exempt. The handler's reads are still analysed: assertions (`as`, `!`, angle-bracket casts), member access, `typeof` operands, and the right side of `in` report, while forwarding reads (call arguments, `throw`, `cause:` properties, `instanceof` discriminations) stay allowed. Output parameters whose every read is the serialized-value argument of `JSON.stringify` or `Response.json` are exempt: serialization accepts every value by design, so it proves no contract and requires none. The sink set is deliberately limited to those two calls resolved to unshadowed globals, and the call must stay pure — feeding the result to `JSON.parse`, drilling into it (`Response.json(x).json()`), or passing a function replacer is transformation, not serialization. Constructor parameter properties are never exempt: `this.body` reads are not parameter references, so no read analysis can cover them. Member access, truthiness, and inline `typeof`/`in` probing of any other unknown parameter still report, as does a parameter that reaches both a sink and any other read.

A binding discriminated with `instanceof Error` (or another class whose name ends in `Error`) holds a thrown value and gets the same analysis as a rejection-handler parameter, so `error instanceof Error ? error.message : String(error)` is clean while `(error as AwsError).name` still reports. Placing the whole value in an object literal field forwards it: TypeScript accepts an `unknown` there only when the field is `unknown`, so the field's reader owns the decoding. A binding that is never reassigned, is serialized by `JSON.stringify` or `Response.json`, and is otherwise only tested is output formatting.

## Controls

Default-off. `allows` exempts exact binding names.

```js
"antidrift/unknown-input-must-be-decoded": ["error", { allows: ["rawProtocolValue"] }]
```

There is no autofix: choosing a decoder or owner is a domain decision.

## Ecosystem

Unsafe-any rules address a different type and do not require decoding unknown boundaries. The existing `no-appeasement-erasure` uses type services to reject discarding an already known contract before parsing it again. This rule requires decoding genuinely unknown inputs. Combining them or adding an automatic rewrite would conflate opposite provenance cases and change existing behavior; keep them separate.

## Corpus

The local Antidrift corpus runs `fixtures/unknown-input/allows.ts`, which decodes an unknown parameter with a real Zod schema. The flags companion returns an unknown through application logic. Unit cases cover predicate dominance, imported signatures, catches, exemptions, shadowing, and invalidation. Independently pinned external evidence remains outstanding.

October 12 2026 precision, on 79 deduplicated TypeScript roots (35 local, 44 on sushi; vendored, generated, build, dot and fixture trees excluded). A hit is true when an unknown value is cast or consumed as domain data without decoding.

| Version                                                            | Hits  | Repositories | Top 5                                                                       | Sample |
| ------------------------------------------------------------------ | ----- | ------------ | --------------------------------------------------------------------------- | ------ |
| Before                                                             | 1,767 | 46           | paseo 307, opencode 251, cloudflare-agents 245, executor 233, LibreChat 144 | 8/20   |
| After thrown-value, object-field and test-and-serialize exemptions | 1,285 | 43           | paseo 197, opencode 195, executor 170, cloudflare-agents 169, LibreChat 122 | 11/20  |

The after run covers 78 roots (sentry did not finish; on those roots the before count is 1,734 in 45). Before, the false positives were mostly error-normalisation helpers. After, they are generic walkers and formatters over arbitrary values, test spies and identity mocks, and stored thrown values without an `instanceof` test. The rule stays below the 70% bar.
