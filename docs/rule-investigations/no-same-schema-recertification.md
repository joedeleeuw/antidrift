# no-same-schema-recertification Investigation

Working names:

- `antidrift/no-same-schema-recertification`
- `antidrift/no-provably-redundant-schema-roundtrip`
- `antidrift/no-schema-output-roundtrip-parse`

Status: `research`, leaning drop. Do not implement or enable without a second independent repository, explicit clean controls, and a real remediation that proves the parse was dead weight.

## Problem Statement

The suspicious shape is a function that accepts a value already typed as a schema output, rebuilds a mostly equivalent object, then parses that object through the same schema and returns the same output type.

Real anchor:

```ts
export function markExplorationTileUnderstood(
  exploration: ExplorationState,
  terrainNodeId: TerrainNodeId,
): ExplorationState {
  return ExplorationStateSchema.parse({
    ...exploration,
    tiles: exploration.tiles.map((tile) =>
      tile.terrainNodeId === terrainNodeId
        ? { ...tile, seen: true, understood: true }
        : tile,
    ),
  });
}
```

This is not a thin factory wrapper. It is not a generic "single returned call" smell. It is a possible same-contract recertification smell: `ExplorationState` in, `ExplorationStateSchema.parse(...)`, `ExplorationState` out.

## Current Coverage

`antidrift/no-redundant-zod-parse` already covers these stable cases:

- same binding parsed again by the same schema,
- awaited or synchronous helper/service result already typed as the schema output,
- inline call result already typed as the schema output.

It intentionally does not flag object-literal construction such as `Schema.parse({ ... })`, because schema-owned construction is often the correct first point where runtime shape is established.

This candidate would cover a different and much riskier shape: a new object literal that is derived from an already schema-owned value.

## Inventory Gate

Run:

```bash
pnpm policy:inventory-schema-roundtrip
```

This is a non-blocking policy inventory, not an ESLint rule. It scans real Codebase Atlas TypeScript programs for `Schema.parse({ ...alreadyTypedSchemaOutput, overrides })`, then classifies each hit by override provenance:

- `owned-only`: overrides derive from the schema-owned value or literals.
- `cross-source`: at least one top-level override derives from another source.
- `export-boundary`: the parse is inside an exported function or public method of an exported class.

The broad Codebase Atlas inventory currently checks 225 files and finds 9 roundtrip shapes: 3 `owned-only` and 6 `cross-source`. The focused regression assertion classifies:

- `LanternController.moveTo` as `cross-source` and `export-boundary`.
- `markExplorationTileUnderstood` as `owned-only` and `export-boundary`.

That split is intentional. The inventory gives us evidence for future promotion or retirement without pretending the direct rule is production-safe today.

## Why This Is Hard

Zod parses are not only TypeScript type assertions. They can enforce runtime constraints TypeScript cannot prove:

- `.strict()` rejects excess keys.
- `.min(...)`, `.int()`, `.regex(...)`, and brands encode runtime constraints.
- `.default(...)`, `.catch(...)`, `.transform(...)`, and preprocessors can change the returned value.
- Schema parses can serve as intentional invariant checkpoints after cross-source joins or state reconstruction.

Codebase Atlas already has the key pair of examples in one file:

- `/Users/sushi/code/codebase-atlas/src/programs/lanternController.ts` lines 48-59: `markExplorationTileUnderstood` mutates only boolean flags on existing typed tiles, so this may be redundant.
- `/Users/sushi/code/codebase-atlas/src/programs/lanternController.ts` lines 13-45: `LanternController.moveTo` rebuilds exploration tiles from terrain state and previous exploration state, so the parse may be an intentional invariant checkpoint.

Those two cases point in opposite directions. That makes this a code-review question today, not a production rule.

## Possible Narrow Slices

### Slice A: Identity-Preserving Recertification

Potentially report only when:

1. The function has a parameter or receiver field typed as schema output `T`.
2. The function returns `Schema.parse(objectExpression)`.
3. TypeScript proves `Schema.parse(...)` returns `T`.
4. The object expression is one spread of the schema-owned value plus shallow overrides.
5. Every override is a literal or already-typed value for a refinement-free field, such as bare `z.boolean()`.
6. No changed field depends on `any`, `unknown`, IO, JSON, request data, storage, DB rows, or broad external values.

This is the only slice that might eventually report the `markExplorationTileUnderstood` shape.

### Slice B: Array Element Rebuilds

Research only. Extend Slice A into `array.map(...)` callbacks where each branch returns either the original element or a spread of the element with refinement-free literal overrides.

This is much more fragile than Slice A because branches, filtering, joining, and nested collections can hide real invariant work.

### Slice C: Cross-Source Rebuilds

Out of scope. Cross-source assembly, such as rebuilding exploration tiles from terrain nodes plus previous exploration state, must stay clean unless real corpus evidence proves a narrower violation.

## Ecosystem Check

No supported ESLint, `typescript-eslint`, SonarJS, or Zod-specific rule was found that covers this exact behavior.

Adjacent ecosystem coverage is not equivalent:

- `@typescript-eslint/no-unsafe-return` and the other `no-unsafe-*` rules cover `any` leakage, not same-schema recertification of already typed values.
- `@typescript-eslint/no-unnecessary-condition` can remove provably redundant checks, but it does not reason about Zod schema provenance or runtime refinements.
- SonarJS maintainability rules cover immediate returns and duplicated code shapes, not schema-output roundtrips.
- Zod's own docs define `.parse` as runtime validation that returns typed data and explicitly note runtime refinements that TypeScript cannot represent.

The broader discourse supports the principle "parse at the boundary, then carry the proof in the type," but also warns against treating validation/parsing as magic. Runtime validation is still necessary at real boundaries and invariant checkpoints.

Sources checked:

- https://typescript-eslint.io/blog/avoiding-anys/
- https://typescript-eslint.io/rules/no-unsafe-return/
- https://typescript-eslint.io/getting-started/typed-linting/
- https://typescript-eslint.io/developers/custom-rules/
- https://zodjs.netlify.app/guide/schema-methods
- https://cekrem.github.io/posts/parse-dont-validate-typescript/
- https://www.reddit.com/r/csharp/comments/1o2wpyw/why_do_people_say_parse_dont_validate/

## False-Positive Risks

Stack-ranked:

1. Runtime refinements. The rule may tell code to delete a parse that enforces `.strict()`, `.min`, `.int`, regex, brand, default, transform, or preprocess behavior.
2. Cross-source reconstruction. A parse after joining typed sources can be a legitimate invariant checkpoint.
3. Public or JS-callable APIs. A TypeScript annotation does not protect untyped callers.
4. Schema-owned construction. Some objects become schema-owned only at the parse call.
5. Field-level mismatch. TypeScript assignability cannot prove a computed string satisfies a non-empty or namespaced string schema.

## False-Negative Risks

Likely escape shapes:

- Assign the rebuilt object to a `const`, then parse the identifier.
- Build through `Object.assign`, helper functions, or builders.
- Move the parse behind a wrapper such as `parseExplorationState(...)`.
- Add a trivial runtime check or branch.

False negatives are acceptable for this candidate. False positives are not.

## Promotion Gate

Keep this candidate in `research` until all of these are true:

1. `markExplorationTileUnderstood` and `LanternController.moveTo` are classified as accepted drift vs accepted clean controls.
2. At least two independent repositories contain accepted real non-test drift anchors that were not added to satisfy the rule.
3. Each accepted drift anchor has a real remediation showing that removing the parse or restructuring the state update improves the code without losing a runtime guarantee.
4. Clean controls explicitly cover schema-owned construction, cross-source rebuilds, default/transform schemas, branded fields, and refinement-bearing overrides.
5. Claude Opus 4.8 advisory review is rerun after the second repo anchor exists.

## Advisory Review

Claude Opus 4.8 advisory completed on 2026-06-08:

- `reports/claude-schema-roundtrip-review-20260608-131924.md`
- `reports/claude-schema-roundtrip-review-20260608-131924.debug.log`
- `reports/claude-higher-level-type-authority-20260608-141831.md`
- `reports/claude-higher-level-type-authority-20260608-141831.debug.log`

The debug log shows `Read` and `Grep` tool use against the repository. The advisory recommendation was: do not implement now; document as a distinct research candidate, leaning toward drop. The main reason is that the current corpus has one repo and one file with two similar-looking cases that likely classify differently.

The second advisory asked whether a higher-level coded control would solve the problem earlier. It recommended the current inventory gate plus a build-pattern entry for schema-owned transition helpers, not a blocking ESLint rule.

## Current Verdict

Do not implement.

Keep this as a small research stub so future work does not accidentally broaden `no-redundant-zod-parse` or `no-thin-typed-factory-wrapper` into a generic construct-and-parse rule. The honest default is drop unless a second independent repo produces an accepted, remediated anchor.
