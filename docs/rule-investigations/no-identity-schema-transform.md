# `antidrift/no-identity-schema-transform`

## Example

The task supplied three identity transforms: direct property reconstruction, shorthand reconstruction from a destructured parameter, and a single explicit return. Each transform returns every input key under the same name without changing any value.

The task also supplied the Murderbox conversation-index decoder as the canonical clean control. The source was confirmed at `apps/client/src/lib/conversation-index.ts` in the local Murderbox corpus. That decoder derives an ID, trims and defaults strings, clamps a count, fills timestamps and status, and coerces a boolean.

## Smell

An identity schema transform adds a second type surface without changing the parsed value's structure. The callback can then hide that the schema's inferred output already owns the contract.

The rule needs type and provenance proof. Syntax alone cannot distinguish a Zod transform from another library's `transform` method or prove the receiver's closed input shape.

## Detection boundary

The rule reports only when all of these facts hold:

- TypeScript resolves the called `transform` method to Zod.
- The callback has one identifier or simple object-pattern parameter.
- TypeScript resolves that parameter to a closed object type without string or number index signatures.
- The callback returns one object literal, either implicitly or through one return statement.
- Every output property passes through the same input property under the same key.
- The output and input key sets match exactly.

The rule abstains on unresolved or indexed shapes, readonly schema receivers, async or aliased callbacks, spreads, computed keys, methods, getters, noncanonical destructuring, added or dropped keys, renamed keys, and any default, coercion, derivation, or other value expression. Readonly transforms can unfreeze an object, and async transforms change the schema's parse contract, so neither is removable identity work.

## Ecosystem

Zod documents `.transform()` as the API for changing schema output and distinguishes schema input from output types. Zod 4 also documents `.overwrite()` for transforms that preserve an inferred type. The ecosystem search found no maintained ESLint rule that combines Zod method ownership, a TypeChecker-resolved closed input shape, and exact pass-through reconstruction.

- [Zod basics: input and output types](https://zod.dev/basics)
- [Zod 4: `.overwrite()` for type-preserving transforms](https://zod.dev/v4)

Generic syntax selectors provide only partial coverage because they cannot prove Zod ownership or compare the returned keys with the input contract.

## Evidence and status

The regression fixtures preserve the three supplied identity cases and every supplied clean case. The Murderbox decoder is the strongest false-positive control. An indexed Zod input fixture confirms that unresolved shapes remain clean.

The rule is ready as default-off inventory. It is not stable because the current evidence has no independently replicated real identity-transform drift.
