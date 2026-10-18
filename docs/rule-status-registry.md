# Rule Status Registry

`policy/registries/rules.yaml` is the rule status registry. It tracks each active `antidrift/*` rule, retired rule, research candidate, and policy-scoped rule review with its status, signal, corpus repositories, production concerns, and next action.

Each active rule entry also declares `examples.flags` and `examples.allows` beside its registration. `pnpm policy:check-registries` fails when an active rule is missing either side, so rule definitions always carry a short positive and negative example.

Active rows can also split evidence into `proven`, `unproven`, and `openReviewConcerns`. Use `proven` for accepted real-program drift or clean controls, `unproven` for remaining blockers before stable promotion, and `openReviewConcerns` for adversarial-review notes that need follow-up. `pnpm policy:check-registries` validates these as string lists when present.

Each active rule also declares an `external` ownership block:

```yaml
external:
  state: partial-overlap
  support: high
  candidates: ["@typescript-eslint/no-unsafe-type-assertion"]
  decision: own-antidrift
  whyThisState: "The upstream rule catches this family, but it is broader than the local policy."
  whyNotOtherState: "Not equivalent because real clean controls are also reported upstream."
```

The two `why*` fields are deliberately required. They are the escape hatch against cognitive drift: a rule cannot simply claim "ecosystem overlap" without explaining why that state is correct and why the closest alternative state is wrong.

`docs/rule-equivalence-audit.md` is the companion ownership audit. It tracks whether a custom rule should be retired in favor of a maintained Oxlint, `typescript-eslint`, plugin, or generated core-config replacement.

`docs/rule-intent-grill.md` is the human-intent clarification layer. Use it when a rule is disputed, symptomatic, or likely made of multiple problems. It records the grill questions, recommended defaults, and local Claude advisory outputs used to decide whether the rule should become ecosystem-covered, sharper custom code, inventory-only/off, or retired.

`policy/registries/rules.yaml` also registers rule families. The current type-contract family is documented in `docs/rule-family-type-contract-authority.md`; it groups the cast, parse, predicate, selector, duplication, and typed-delegation subsets so future work can draw scope boundaries before adding rules.

The `policyRuleReviews` section closes the broader policy surface. Every rule ID named in `policy/agent-guardrails.yaml` must have a row there, even when it is not a custom lint rule. `pnpm policy:check-registries` fails when a policy ID is missing, when the registry invents an extra policy review, or when an `active-custom` review points at a non-active `antidrift/*` rule. Runtime ownership changes are explicit `[policy-change]` work.

Each rule is judged on its own merits through a senior JavaScript/TypeScript tooling lens. If an ecosystem rule covers the same behavior, the custom rule becomes an elimination candidate. If a signal is too broad or symptomatic, the next action is to reformulate the failure mode until the rule has a narrow construction pattern. If a rule's value is unclear, first recover the original local complaint from the current session, handoff docs, reports, or available Codex memory; then test that complaint against real code and ecosystem rules. If the value still cannot be stated clearly, do not implement it; collect at least three close ecosystem/readme references or practitioner writeups and keep the candidate in `research` until the "why" is defensible.

This document defines the vocabulary the registry uses. It holds no per-rule facts of its own: per-rule status, severity, retirement, and promotion are declared in `policy/registries/rules.yaml` and enforced by `pnpm policy:check-rule-surface`. That check also keeps maturity and severity aligned: `under-proven`, `false-positive-prone`, and `research` rules must not be configured as blocking (in this repository both `warn` and `error` count as blocking because the lint gate runs with zero-warning discipline).

## External Ownership States

These states answer whether `antidrift` should own code for the rule or defer to a maintained Oxlint or ecosystem rule/config.

| External state       | Meaning                                                                                   | Example decision                                                                |
| -------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `equivalent`         | A maintained ecosystem rule covers the same behavior and ambition.                        | Use upstream and retire custom code.                                            |
| `broader-upstream`   | A maintained rule catches the target but also reports a materially larger policy surface. | Keep custom, or stage upstream separately after inventory.                      |
| `narrower-upstream`  | A maintained rule catches a subset but misses the local ambition.                         | Use both only if the messages remain distinct.                                  |
| `partial-overlap`    | Existing rules cover nearby behavior but not the exact failure mode.                      | Keep custom and document the gap.                                               |
| `config-replacement` | Oxlint core config could express the behavior, often through generated restrictions.      | Prefer config when it stays readable; keep code when context/exceptions matter. |
| `net-antidrift`      | No supported equivalent was found for the scoped behavior.                                | Own custom only with real corpus evidence.                                      |

`support` records how much confidence we have in the external candidate itself: `none`, `low`, `medium`, or `high`. Support is not equivalence. A highly supported rule can still be the wrong replacement if its scope is broader, narrower, or aimed at a different failure mode.

## Signal Definitions

Use these labels literally. A rule should not claim a deeper signal than it actually uses.

| Signal                             | Declarative definition                                                                                                                                                               | Good examples                                                                                     | Not enough for                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `deterministic AST`                | The source syntax itself is the construction pattern being banned. The rule does not need to infer ownership, trust, or semantic intent.                                             | `as unknown as T`; `.forEach(async () => ...)`; `useEffect(fn)` with no dependency array.         | Proving a type guard is sound; proving a domain model is canonical; proving data is untrusted. |
| `class-string`                     | The string literal or extracted class token is the policy surface.                                                                                                                   | Raw Tailwind color utilities; hover translate utilities on pointer targets.                       | Inferring design intent from arbitrary component names.                                        |
| `source-comment`                   | The comment text itself is the policy surface.                                                                                                                                       | Bare `eslint-disable`; `@ts-ignore` without a reason.                                             | Proving the disabled rule was safe.                                                            |
| `scope-binding`                    | The rule follows local bindings inside a file so it reports the thing actually referenced, not a name coincidence.                                                                   | React state setter co-mutation inventory in one handler.                                          | Proving the co-mutation is harmful without transition evidence.                                |
| `authority-index plus AST context` | Accepted repo authority facts limit where source shape applies.                                                                                                                      | Status or role literal type redeclarations.                                                       | Whole-model structural equivalence without TypeChecker support.                                |
| `TypeChecker`                      | The rule depends on TypeScript's inferred types, symbol identity, assignability, or parser services.                                                                                 | `any`/`unknown` JSON parse; appeasement casts; installed package and generated-source type forks. | Rules that must work in non-type-aware linting.                                                |
| `import-graph`                     | The rule reasons over file-to-file import edges.                                                                                                                                     | Relative import cycles.                                                                           | Runtime call graphs or dataflow.                                                               |
| `heuristic`                        | The rule intentionally uses an incomplete signal because no deterministic signal is available yet. It should be warning-level or under-proven until real inventories show low noise. | Status triplets by configurable state names; obvious comments.                                    | Stable promotion without multiple clean inventories.                                           |

Syntax should be a violation only when the construction pattern is the policy. If a rule is trying to prove meaning, ownership, trust, or type authority, it needs a stronger signal than syntax.

## Investigation Flow

Start investigation before code:

1. Create or update a reference doc under `docs/rule-investigations/`.
2. Recover the original complaint from the current session, local handoff/report docs, or available Codex memory. Summarize it as a concrete failure mode, not as a quote dump, then classify its truth artifact through `docs/rule-mining-protocol.md` before choosing lint, semantic lint, hook, workflow, or advisory form.
3. Check existing ESLint, `typescript-eslint`, and relevant plugin coverage.
4. Update `docs/rule-equivalence-audit.md` when the rule is active, replaceable, or net-new.
5. Kick off a read-only Claude Opus 4.8 advisory review using `docs/claude-rule-review-protocol.md`.
6. Mark the candidate `ecosystem-covered` when an existing rule is sufficient.
7. If the "why" is still unclear, find three close ecosystem rules, plugin readmes, or practitioner references and summarize why each is equivalent, broader, narrower, or only adjacent.
8. Keep the candidate `research` until a real drift file and clean control prove a custom rule is needed.

## Advisory Review

Use `docs/claude-rule-review-protocol.md` before stable promotion or when a rule's signal is disputed. The review must be read-only, grounded in current code, written to `reports/`, and treated as advisory evidence only.
