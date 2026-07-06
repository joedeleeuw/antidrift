# no-duplicated-conditional-classnames

## Intent

Flag conditional class strings whose branches repeat the same base class list and differ only by a small state-specific suffix. The rule targets code where the shared class contract is hidden inside both branches instead of being hoisted once.

## Detection

The rule is AST-only. It inspects conditional expressions nested anywhere inside configured JSX class attributes such as `class` and `className`. Standalone class helper calls are opt-in through the `helpers` option for repositories that want that surface.

For static string branches, it splits on whitespace, compares unique class tokens, and reports when at least four tokens overlap and the overlap covers at least 65 percent of the shorter branch by default. The detector does not match specific variable names, files, or class tokens.

## Controls

The alert surface is configurable through ESLint rule options. Omit the options object to use the defaults, or provide the complete shape below. Partial or malformed option objects fail loudly through the rule schema and runtime validation.

```js
"antidrift/no-duplicated-conditional-classnames": [
  "warn",
  {
    attributes: ["class", "className"],
    helpers: [],
    minSharedRatio: 0.65,
    minSharedTokens: 4,
  },
]
```

Use `minSharedTokens` and `minSharedRatio` to tune alert volume. Use `attributes` to match JSX class attribute names. Use `helpers` only when a repository wants to scan standalone class-composition calls outside JSX attributes.

## Ecosystem

`sonarjs/no-duplicated-branches` covers identical conditional branches. `sonarjs/no-duplicate-string` covers repeated whole string literals. Tailwind ESLint plugins catch duplicate or contradicting classes inside one class string. None of those rules compare the two class strings in a conditional and ask the author to hoist the shared class list.

## Corpus

The first drift case is the Murderbox client send button className branch where both branches share the same eight base classes and differ only by `opacity-50` versus `active:opacity-75`.

Keep the rule default-off until more real UI files are classified for clean pressure and false positives.
