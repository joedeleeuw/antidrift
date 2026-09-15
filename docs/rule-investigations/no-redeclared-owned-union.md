# no-redeclared-owned-union

## Intent

Keep a literal value space owned by its runtime constant array. Repeating the same members in a type alias or Convex validator creates a second place to update.

## Detection

AST-only, without a TypeScript program or type checker. String/number literal type unions and `v.union(v.literal(...), ...)` match an exported `as const` array in the same file or a statically resolved imported array. Imports use TypeScript module resolution, including local tsconfig paths and JavaScript extension substitution; source parsing does not execute modules. Named, renamed, default, and namespace imports are supported. Local export lists are supported; re-exports through other modules and computed arrays are deliberately unproven.

Member sets must match exactly. Order and duplicates are ignored; string case, whitespace, and the distinction between numbers and strings are preserved. Scope resolution rejects shadowed owners, type-only imports, and unrelated validator libraries. Convex validators must use the `v` export of `convex/values`, including renamed imports. Imported owners are cached only for the current linted file.

## Controls

Default-off. `allows` contains type alias names or validator binding/property paths such as `phase` or `validators.phase`.

```js
"antidrift/no-redeclared-owned-union": ["error", { allows: ["WirePhase"] }]
```

Derive types with `(typeof PHASES)[number]` and validators with `v.union(...PHASES.map(v.literal))`. There is no autofix: choosing among equivalent owners and preserving Convex tuple typing requires review.

## Ecosystem

Duplicate union-member checks concern repetition within a union. This rule instead compares the union to an in-scope runtime owner. Ecosystem ownership remains provisional pending external inventory.

## Corpus

The local Antidrift corpus checks the actual `fixtures/owned-union/allows.ts` source through the corpus runner; its companion flags fixture proves imported-owner detection. Unit fixtures also cover normalized numeric sets, import aliases, shadowing, exemptions, and Convex binding provenance. No independently pinned external checkout was examined. Keep default-off until external false-positive evidence is available.
