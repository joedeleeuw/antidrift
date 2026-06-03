# Rule Equivalence Audit

This audit answers a narrower question than the readiness registry: why does `antidrift`
own a custom rule instead of using a maintained ESLint, `typescript-eslint`, or plugin
rule?

Default posture: if a supported ecosystem rule covers the behavior, retire the custom
rule and wire the ecosystem rule into the single ESLint config path. Keep custom rules
only when the behavior is genuinely project/agent-specific, TypeChecker-proven in a
way the ecosystem rule does not express, or registry-backed.

## Classification Meanings

| Classification | Meaning |
|---|---|
| Direct replacement | A maintained rule covers the behavior directly enough that custom ownership should end after parity validation. |
| Replacement candidate | A maintained rule or rule combination probably covers it, but the blast radius is wider or the match is partial enough to require corpus validation first. |
| Config replacement | The behavior can likely be expressed by generated ESLint core configuration such as `no-restricted-imports` or `no-restricted-syntax`; keep code only if the generated config becomes unmaintainable. |
| Partial ecosystem overlap | Existing rules catch part of the smell, but not the original antidrift behavior. |
| Net antidrift | No supported equivalent was found; keep custom only if real corpus validation justifies the signal. |

## Evaluated Direct Replacements

These were checked against real program evidence.

| Current custom rule | Classification | Supported replacement | Notes |
|---|---|---|---|
| `antidrift/no-cycle` | Retired | `import-x/no-cycle` | Replaced by maintained import-graph coverage in the ESLint config. |
| `antidrift/no-unsafe-cast-chain` | Keep custom | `@typescript-eslint/no-unsafe-type-assertion` | The ecosystem rule catches the real cast-chain drift, but it also reports many broader assertions. Treat as a future staged/baselined policy, not a blind replacement. |
| `antidrift/no-appeasement-cast` | Keep custom | `@typescript-eslint/no-unsafe-type-assertion` | The ecosystem rule catches the intended AxiosError drift but flags real clean controls such as SDK conversion and generic API response casts. |
| `antidrift/no-cast-to-branded` | Keep custom | `@typescript-eslint/no-unsafe-type-assertion` | No real branded boundary exists yet; keep the brand-specific rule under-proven rather than replacing it with a broader assertion rule. |
| `antidrift/no-async-array-method` | Keep custom | `@typescript-eslint/no-misused-promises` plus `@typescript-eslint/no-floating-promises` | The ecosystem pair catches the real async `forEach` only with `checksVoidReturn.arguments` enabled, which creates real Express-route noise. Disabling that option removes the noise and misses the drift. |
| `antidrift/no-silent-catch` | Keep custom | ESLint `no-empty`, `sonarjs/no-ignored-exceptions`, and `no-console` | The ecosystem combination misses comment-only silent catches and `no-console` is too broad for console-only catch parity. |
| `antidrift/no-inline-disable-without-ticket` | Retired | `@eslint-community/eslint-comments/require-description` plus `@typescript-eslint/ban-ts-comment` | Replaced because the accepted policy is "explicit reason is enough." |
| `antidrift/no-sql-string-concat` | Keep custom | `sonarjs/sql-queries`, `sql/no-unsafe-query`, or SQL-template plugins | SonarJS does not catch the real HoGQL interpolation case. SQL plugins are oriented around chosen SQL/tagged-template conventions, so keep custom until the repo chooses a query convention. |

## Possible Config Replacements

These may not need custom rule code, but the replacement is generated config rather than
a named third-party rule.

| Current custom rule | Classification | Possible replacement | Notes |
|---|---|---|---|
| `antidrift/no-sdk-direct-use` | Retired | Generated `no-restricted-imports` with file overrides for approved gateway wrappers | The gateway registry now emits core ESLint import restrictions; custom code is no longer needed. |
| `antidrift/no-status-literal-in-type` | Keep custom | Generated `no-restricted-syntax` selectors from the domain registry | Core selectors could match literal values, but the owner-file exception and status-context narrowing are clearer and safer in the custom rule. |
| `antidrift/no-role-literal-in-type` | Keep custom | Generated `no-restricted-syntax` selectors from the domain registry | Same decision as status literals. |
| `antidrift/no-raw-tailwind-color` | Keep custom | Generated `no-restricted-syntax` over JSX/string literals, or a design-system plugin if one is adopted | Tailwind plugins validate Tailwind correctness, not "semantic token only" policy. The custom rule statically extracts class strings from JSX expressions more readably than selector strings. |
| `antidrift/no-hover-translate-card` | Keep custom | Generated `no-restricted-syntax` over class strings | Keep the small extractor rule for static class expressions; no supported plugin owns this pointer-target interaction policy. |

## Partial Ecosystem Overlap

These should stay custom unless the policy is intentionally narrowed to the ecosystem
behavior.

| Current custom rule | Classification | Ecosystem overlap | Why it is not a full replacement |
|---|---|---|---|
| `antidrift/require-effect-deps` | Partial ecosystem overlap | `react-hooks/exhaustive-deps`; `eslint-plugin-use-effect-no-deps` exists | `exhaustive-deps` validates arrays that exist; it does not own "array must exist." The exact one-rule plugin appears stale, so it is not a strong supported replacement. |
| `antidrift/no-raw-fetch-in-component` | Partial ecosystem overlap | `no-restricted-syntax` could ban `fetch` in broad file globs | The custom rule narrows to component/component-module context and gives architecture-specific guidance. A raw syntax ban is cruder. |
| `antidrift/no-inline-structural-type-at-use-site` | Partial ecosystem overlap | `no-restricted-syntax` can ban `TSTypeLiteral` in some positions | The custom rule limits the ban to exported/boundary functions and avoids React component props. Keep unless generated selectors can express those boundaries clearly. |

## Net Antidrift

No supported equivalent was found for these as currently scoped.

| Current custom rule | Signal | Why it is net |
|---|---|---|
| `antidrift/no-trivial-selector-wrapper` | AST structural return shape | Detects inference-appeasement wrappers that only return a property of their own parameter. This is specific to the project goal, not a general lint convention. |
| `antidrift/no-coupled-state-setters` | Scope binding | Detects a handler mutating multiple state cells owned by an ancestor component. Existing React rules do not model this state-shape smell. |
| `antidrift/no-status-triplet-state` | Configurable state-name groups plus React state shape | Heuristic by nature, but no maintained equivalent was found for data/loading/error triplets. Keep under evidence pressure. |
| `antidrift/no-nullable-positional-tuple` | Deterministic AST | Detects tuple types with multiple nullable or optional slots, such as date ranges or result tuples that hide field meaning and partial-state combinations. This is narrower than a generic tuple-style rule. |
| `antidrift/no-obvious-comment` | Heuristic token overlap | Existing `no-warning-comments` catches TODO/FIXME-style markers, not comments that restate adjacent code. Keep low-confidence unless inventories stay clean. |
| `antidrift/no-structural-type-fork` | TypeChecker structural comparison plus generated registry | Detects hand-written structural copies of installed package types and configured generated-source exported types. This is core antidrift behavior. |
| `antidrift/no-redundant-zod-parse` | TypeChecker plus Zod provenance | Detects re-parsing a value with the same schema that already produced or typed it. No Zod ecosystem rule was found for this provenance pattern. |
| `antidrift/no-underchecked-type-predicate` | TypeChecker plus AST/control-flow checks | Detects broad-input type predicates that assert a nontrivial object contract without checking asserted fields or delegating to a validator. Existing type-aware rules do not validate predicate-body sufficiency. |
| `antidrift/no-unsafe-deserialize` | TypeChecker | Detects `JSON.parse` on `any`/`unknown` input. Security plugins cover broader smells, but not this type-signal parse-at-edge rule directly. |
| `antidrift/require-authz-check` | AST control-flow plus registry | Requires configured authz/ownership calls in boundary handlers that read request params. This is repo-policy control flow, not a generic ESLint rule. |
| `antidrift/no-defensive-shape-probing` | Deterministic AST, under-proven | No equivalent was found for Object.entries normalizers that repeatedly probe broad object shape. Keep under-proven until real evidence justifies it. |

## Remaining Retirement Candidates

No active custom rule currently has a proven safe drop-in replacement. Reopen retirement only when a real repository shows the ecosystem rule catches the intended drift, keeps the clean controls clean, and does not create unrelated inventory noise.
