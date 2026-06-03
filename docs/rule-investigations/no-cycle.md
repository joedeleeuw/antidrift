# no-cycle Investigation

## Current State

`antidrift/no-cycle` is retired. Import-cycle enforcement now uses `import-x/no-cycle` in the single ESLint config path.

The retired custom implementation was intentionally small, but it had known limits:

- It follows only relative imports.
- It does not resolve TypeScript path aliases or package/workspace imports.
- It reparses neighboring files while linting.
- It may report the same cycle from more than one file.

## Ecosystem Check

Existing ecosystem coverage:

- `eslint-plugin-import` has `import/no-cycle`, which checks for a resolvable path back to the linted module.
- `eslint-plugin-import-x` also has a `no-cycle` rule in the same rule family.
- `eslint-plugin-boundaries` enforces dependency policies between configured architectural elements, but it is not a general cycle detector.

This means circular dependency detection is not a novel antidrift rule area. The project should use maintained import-graph coverage unless a real package constraint proves that impossible.

## Advisory Review

Claude Opus 4.8 read the implementation and agreed this problem is ecosystem-covered. The advisory review is saved at:

```txt
reports/claude-rule-review-no-cycle-20260602-024727.md
```

The review recommended retiring the custom rule in favor of ecosystem import-graph coverage unless package constraints require a lightweight relative-only fallback. The custom rule was retired and replaced with `import-x/no-cycle`.

## Potential Directions

1. **Current path**: use `import-x/no-cycle` with node resolver extensions for TypeScript and JavaScript source.
2. **Fallback only**: reintroduce custom cycle detection only if package constraints or real project evidence show the maintained plugin cannot be used.
3. **Avoid hardening custom traversal**: alias/workspace resolution, graph caching, and duplicate suppression recreate ecosystem import-graph tooling.

## Known Risks

- False negatives through aliases and package imports.
- False positives through type-only import cycles.
- Duplicate reports from the same cycle.
- Performance costs from reparsing imported files.
- Confusion with `eslint-plugin-boundaries`, which solves dependency direction but not arbitrary cycles.

## Entry Conditions For Reintroducing Custom Coverage

- Existing ecosystem cycle rules are unavailable or unsuitable for the package constraints.
- Multiple real repositories show cycles that this custom rule catches accurately.
- Broad inventories show no duplicate-report or performance concern.
- Claude Opus 4.8 review agrees the custom rule is worth owning despite ecosystem coverage.
