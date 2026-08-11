# no-sentinel-absence-fallback

## Intent

Flag `?? "<sentinel>"` on a member read, where the sentinel is one of a small in-band absence vocabulary: `unknown`, `n/a`, `none`, `unavailable`, `error`, `missing` (case-insensitive). Coercing a missing property to an in-band string makes absence indistinguishable from a real state — a service that never reported its `ActiveState` reads exactly like a service whose state genuinely is the string `"unknown"`. Absence should be modeled as absence: an optional field, `null`, or a parsed enum with an explicit unavailable member.

Motivation anchor: the Murderbox `docs/type-authority` audit (entry point `SOURCE-AUDIT.md`, Finding 8 — provider/wire values surviving into application readers; live evidence in `evidence/LIVE-AUTHORITY-MAP.md` — "Systemd state strings reinterpreted in client code" — and `evidence/PHASE-0-API-PROVIDER-AUDIT.md` — systemd wire values must terminate in the receiving adapter). The concrete site is `apps/api/lib/server/chat-runtime.ts`, which reads systemd D-Bus properties as `props.ActiveState ?? "unknown"` and, worse, `Number(props.ExecMainStatus ?? 0)` — exit code 0 means success, so a missing property reads as "exited cleanly".

## Detection

The rule is AST-only, syntax-rule family, single definition in `tooling/antidrift/src/syntax-rules.mjs` (no TypeChecker is available to the Oxlint JS plugin by design — see `docs/lint-rule-parity.md`). It reports a `LogicalExpression` when all of the following hold:

- the operator is `??` (never `||` — falsy coercion is a different doctrine);
- the left side, after unwrapping chain/TS as-expression wrappers, is a `MemberExpression` read, including optional chaining (`props.ExecMainStatus`, `row?.state`, `result.statuses[id]?.safeStatus`);
- the right side is a string literal or no-substitution template literal whose lowercase value is in the sentinel set, so `"N/A"` is caught by the same comparison.

## Boundaries (deliberate false negatives)

- `||` operator: falsy coercion doctrine, out of scope.
- Numeric sentinels (`?? 0`, `Number(x ?? 0)`): proving drift there needs property-name semantics (exit code 0 meaning success), and name-trust is rejected. The `ExecMainStatus ?? 0` half of the anchor site therefore stays silent in v1.
- Call-expression LHS (`get(key) ?? "unknown"`): v1 stays member-read-only; the murderbox corpus did not surface a call-LHS drift site, so there is no evidence to justify the extra surface and its false-positive risk is unmeasured.
- Plain-identifier LHS (`maybeName ?? "unknown"`): the corpus shows these are locals whose provenance is not visible at the expression — display-only fallbacks like `score ?? "unknown"` in an accessibility label would flag without evidence the identifier carries wire state.
- Sentinels outside the fixed set (display strings like `?? "Untitled"` or `?? "Loading…"`) never fire.

## Ecosystem

Checked 2026-08-10. `no-null` and `@typescript-eslint/prefer-nullish-coalescing` police which operator a codebase uses, not the value the operator produces; neither carries a sentinel vocabulary or an absence doctrine. No maintained rule models absence coerced to an in-band sentinel string on a member read. State: net-antidrift.

## Corpus

Drift anchor (murderbox, `apps/api/lib/server/chat-runtime.ts:379-381`): three systemd D-Bus reads (`ActiveState`, `SubState`, `Result`) coerced to `"unknown"`, validated as the `murderbox-systemd-service-sentinel-fallback` external corpus drift case. Sibling sites in `apps/api/lib/server/runtime-status.ts:162-163` and `runtime-load-progress.ts:88` repeat the pattern. Murderbox member-read sites also land on diagnostics display surfaces (`apps/client/app/runtime-diagnostics.tsx`, `apps/client/app/_debug.tsx` — `active?.chatModel ?? "unknown"`), which is the false-positive pressure a promotion review must measure. dotfiles has zero `?? "<sentinel>"` sites and remains the clean control repository.

Keep the rule default-off until that display-surface pressure is inventoried in at least one more repository.
