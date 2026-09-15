# unknown-input-must-be-decoded

## Intent

Decode explicitly unknown parameters and local bindings before their values enter application logic. Catch bindings are exempt.

## Detection

AST-only, with lexical reference resolution. Each read must be a direct decoder argument, a proved type-predicate argument, or a use dominated by a successful predicate/assertion. The rule reports once on each offending binding's unknown annotation. Unused bindings and type-only references have no unsafe reads.

Decoder names start with `decode`, `parse`, `validate`, or `safeParse`, followed by the end of the name, an uppercase letter, or an underscore. Both plain calls and noncomputed method calls qualify. These names are a syntax convention, not proof that a runtime implementation validates correctly. Calls do not narrow the original binding: use their decoded result.

Predicates require a visible `value is Type` or `asserts value is Type` signature, either locally declared or directly imported from resolvable source/declarations. Imported aliases work; re-export chains, namespace methods, and inferred signatures are not followed. Merely naming a boolean helper `isMessage` is insufficient. Optional predicate calls are not proof.

Successful if branches, conditional expressions, `&&`/`||` guards, loop tests, assertion statements, and guards whose failing branch exits can establish narrowing. Ignored boolean results cannot. Reassignments invalidate proof; mutable captures and loops with writes cannot inherit outer narrowing. Analysis is conservative across branch writes and unsupported control-flow forms. This is not a general TypeScript flow checker: inline truthiness/typeof probes do not replace decoding under this policy. Low-level decoder implementations can use explicit exemptions.

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
