# no-duplicated-object-field-blocks

## Intent

Flag repeated field blocks across sibling Zod object shapes or TypeScript object type declarations. The rule targets declarations where a shared contract is hidden in copy-pasted fields instead of being named once and reused through a spread, interface extension, or intersection.

## Detection

The rule is AST-only. It collects object literals passed as the sole argument to a `.object(...)` call separately from `TSTypeLiteral` and `TSInterfaceBody` nodes. Ordinary runtime object literals are outside the rule's scope.

A field is identified by its static identifier or string key plus the whitespace-normalized source text of its value expression or type annotation. Fields with the same name but different source types do not match. The detector groups fields by the exact set of shapes in which they occur and reports a group only when its field count, shape count, and redundant-declaration score reach the configured thresholds. Spread and non-property members are opaque, so already-factored shapes contribute only fields declared directly in the literal or body.

## Controls

The alert surface is configurable through ESLint rule options. Omit the options object to use the defaults, or provide the complete shape below. Partial, unknown, or malformed option objects fail loudly through the rule schema and runtime validation.

```js
"antidrift/no-duplicated-object-field-blocks": [
  "warn",
  {
    minSharedFields: 2,
    minShapes: 2,
    minRedundantDeclarations: 3,
  },
]
```

The redundant-declaration score is `shared fields * (shapes - 1)`. With the defaults, two fields repeated across three shapes score four and report; two fields repeated across two shapes score two and remain clean; three fields repeated across two shapes score three and report.

## Ecosystem

ESLint's `no-dupe-keys` rule catches duplicate keys inside one object literal, not shared fields across separate shape declarations. SonarQube copy-paste detection and generic duplicate-code scanners cover larger repeated token or line blocks, but do not provide this small shape-aware signal or distinguish Zod and TypeScript declaration shapes from runtime objects. The gap is narrow enough for a local AST rule without TypeScript services.

## Corpus

The first drift case is Murderbox client `apps/client/src/lib/voice-openai-session.native.ts`. Three sibling `z.object(...)` event schemas repeated `item_id: z.string()` and `content_index: z.number()`. The corrected form declares `transcriptItemFields` once and spreads it into each event shape; the fixed file is the first clean external-corpus control.

Keep the rule default-off until additional schema-heavy repositories quantify true-positive and false-positive pressure.
