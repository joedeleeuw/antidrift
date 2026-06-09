# no-role-literal-in-type Investigation

## Status

Retired. It was implemented as `antidrift/no-role-literal-in-type`, but removed from the active custom rule surface after review.

This is the role-vocabulary sibling of `antidrift/no-status-literal-in-type`: repo role strings should live in the domain owner and be imported or derived from that owner, not redeclared as local unions.

## Scope

The positive pattern is:

```ts
import type { Role } from "@agent-guardrails/domain";
```

The drift pattern is:

```ts
type Role = "admin" | "member" | "viewer";
```

The rule is not intended to ban runtime role strings, JWT claim strings, test payload text, or UI copy. It only visits TypeScript string literal types in role-like type contexts.

## Current Solve

The rule uses registry values from `policy/registries/domain.yaml`, skips the configured owner file, and reports configured role literals in role-like type contexts.

The shared config no longer wires this rule. Role ownership should be reopened only through a stronger canonical-model rule or generated config if real code proves a separate role surface.

## Ecosystem Check

Generated `no-restricted-syntax` selectors could match string literal types whose values are configured role strings. That is a possible config replacement, but it is weaker than the custom rule because a raw selector cannot carry the owner-file skip and role-type context cleanly.

This rule stays custom by parity with `no-status-literal-in-type`, but its evidence is weaker. The current values (`admin`, `owner`, `member`, `viewer`) are generic, and generic values make false positives more likely than status values.

## Real Corpus Evidence

Current Chaski evidence is clean-control-heavy rather than drift-heavy:

- Canonical role definitions live in their owner.
- Consumers import the canonical role values instead of redeclaring the union.
- Runtime role claim strings and payload values should stay out of scope.
- A fallback candidate behind a blanket disable does not count as surfacing evidence.

No accepted real non-disabled role-union redeclaration exists yet, so the rule remains under-proven.

## False-Positive Risks

Stack-ranked:

1. Generic role words. `owner`, `admin`, `member`, and `viewer` can describe resource permissions, document roles, UI variants, or domain concepts unrelated to auth roles.
2. Name-gate fragility. The current context check is role-name-shaped; a non-auth `DocumentRole` can look in-scope, while an auth `AccessLevel` can escape.
3. Single-literal reporting. One matching role literal is too weak for enablement because generic values are common.
4. Config replacement overreach. A raw selector would flag the owner module and unrelated type literals unless every exception is generated carefully.

## Promotion Gate

Keep this rule default-off until all of these are true:

1. At least one real, non-disabled role-union redeclaration outside the owner is accepted as drift.
2. The trigger is hardened to require a stronger signal, such as two or more distinct configured role literals in the same union.
3. Clean controls include owner-file declarations, runtime role strings, JWT claim strings, UI variants, and non-auth role-like domain types.
4. A broad inventory over at least two repositories shows zero accepted false positives.

Stable promotion still requires two independent repositories, no known false positives or false negatives, and a grounded advisory review.

## Advisory Review

Claude Opus 4.8 prospect review completed on 2026-06-08:

- `reports/claude-prospect-reviews/20260608-132852-role-literal-in-type.md`
- `reports/claude-prospect-reviews/20260608-132852-role-literal-in-type.debug.log`

The review recommended keeping the rule under-proven and default-off, wiring the registry options even while off, and hardening the trigger before any enablement. It also recommended not replacing the rule with generated `no-restricted-syntax` because the owner-file and context exceptions are the useful part of the custom implementation.

## Current Verdict

Retired.

Do not reopen until a real role-union redeclaration appears outside the owner and cannot be handled by `domain/no-canonical-model-fork` or generated config. Before any future enablement, the signal would need a multi-literal role-union floor and broad clean controls for owner modules, runtime role strings, JWT claim strings, UI variants, and non-auth role-like domain types.
