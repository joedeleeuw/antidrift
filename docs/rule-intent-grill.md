# Rule Intent Grill

Last updated: 2026-06-10.

This document is for deciding whether a rule deserves custom code. It is intentionally human-first: before implementing or promoting a rule, state the job failure in plain language, then decide whether the right answer is an ecosystem rule, a sharper detector, inventory-only/off, or retirement.

## Grill Method

For each disputed rule, ask:

1. What are we actually mad about?
2. Is this one problem, or two separate problems wearing one name?
3. Can the problem be solved earlier by enforcing a construction pattern instead of detecting the bad result?
4. Can the problem be solved by a broader maintained rule without losing the local intent?
5. If custom code remains, what signal proves the failure without substring banks or vibes?
6. What real drift and clean controls would make this safe to block?

Recommended default: if the answer to question 1 is unclear, do not implement. If the signal in question 5 is only names, comments, or generic counts, keep the rule off or retire it unless the string itself is the policy surface.

## Current Outcome Map

This map is the working answer to the goal: unclear rules must move toward ecosystem coverage, a sharper detector, inventory-only/off, or retirement. `ready but not stable` is not a product decision by itself; it only means code exists and the current gates pass.

| Outcome                            | Rules                                                                                                                                                                                                                                                                                       | Current decision                                                                                                                                                                                                                                                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ecosystem-covered or retired       | `no-cycle`, `no-inline-disable-without-ticket`, `no-sdk-direct-use`, `no-silent-catch`, `no-explicit-return-type-private-helper`, `no-thin-typed-factory-wrapper`, `no-obvious-comment`, `no-role-literal-in-type`, `no-cast-to-branded`, `no-unsafe-cast-chain`, `no-status-triplet-state` | Locked in `docs/rule-status-registry.md`; do not reopen without new real-code evidence and checker changes.                                                                                                                                                                                                              |
| Rewrite with sharper detector      | `no-appeasement-cast`, `no-sql-string-concat`, `no-underchecked-type-predicate`, `no-handrolled-resource-lifecycle-cells`, `no-async-array-method`, `no-nullable-positional-tuple`, `no-structural-type-fork`, `no-canonical-model-fork`, `require-authz-check`                                           | Keep custom only where the sharper signal is explicit: broad-input authority casts, type-aware SQL identifier proof, degenerate authority claims, redundant constant state cells, branch-specific async array control flow, nullable/optional tuple slots, owner-backed structural contracts, and typed policy wrappers. |
| Inventory-only/off unless proven   | `no-defensive-shape-probing`                                                                                                                                                                                                                                                                | `no-defensive-shape-probing` is default-off unless a second drift proves value beyond upstream unsafe-member rules.                                                                                                                                                                                                      |
| Config/theme replacement candidate | `no-raw-tailwind-color`, `no-hover-translate-card`, `no-inline-structural-type-at-use-site`, `no-status-literal-in-type`                                                                                                                                                                    | Prefer generated config or construction constraints when readable; keep custom code only when extraction context and exceptions are materially clearer than config.                                                                                                                                                      |

## Current Grill Targets

### React Split Resource State

Rules:

- `antidrift/no-status-triplet-state`
- `antidrift/no-handrolled-resource-lifecycle-cells`
- research: `react/no-use-state-waterfall`, `react/no-effect-fetch-waterfall`

Human problem:

React async/resource state gets modeled as separate mutable facts, even when one or more facts can be derived from the resource value or lifecycle transition.

Bad framing:

- "Find data/loading/error names."
- "Find any component with N `useState` cells."
- "Prefer reducers everywhere."

Better split:

- The retired `no-status-triplet-state` rule was really about derivable resource lifecycle facts.
- `no-handrolled-resource-lifecycle-cells` is about local state cells behaving like one implicit resource lifecycle machine.
- The behavior-based subset collapsed into `no-handrolled-resource-lifecycle-cells` plus a redundant-constant-cell proof: one setter writes a constant such as `false` or `null` whenever another setter receives the resource value.
- Fetch/effect waterfall is a separate data-loading architecture problem, mostly pressured by `no-raw-fetch-in-component` and React Hooks rules.

Recommended default:

Keep `no-status-triplet-state` retired. Names can be hints, not proof; resource-lifecycle enforcement now belongs to `no-handrolled-resource-lifecycle-cells` through async boundary, related setters, and derivable lifecycle-cell evidence.

First human grill question:

If a component has `data`, `loading`, and `error`, but all three are fed directly by TanStack Query or another resource hook, should antidrift ever report it?

Recommended answer: no. The problem is local mutable lifecycle modeling, not the visible words.

Current advisory:

Claude Opus 4.8 reviewed this branch in `reports/claude-react-grill-stream-auth-20260609.md`. It agreed the direction is right, but challenged the standalone rule boundary: derivability is the proof that a coupled cell is redundant, so the sharper rule became `no-handrolled-resource-lifecycle-cells` with a redundant-constant-cell branch.

Next human grill question:

If the only deterministic proof of derivability is a setter writing one cell to a constant whenever another cell is set, should `no-status-triplet-state` retire and fold into `no-handrolled-resource-lifecycle-cells`?

Human answer (2026-06-10): yes. Any-co-mutation as a blocking signal is false-positive-prone by definition because multiple setters in one handler is often correct React. The redundant-constant-cell branch is the blocking core, the broad co-mutation signal stays classification inventory, and the standalone name-group rule retires after the fold.

### Broad-Input Type Authority

Rules:

- `antidrift/no-appeasement-cast`
- `antidrift/no-defensive-shape-probing`
- `antidrift/no-underchecked-type-predicate`

Human problem:

Code receives broad input and then claims a narrower contract without earning it through parsing, guarding, or importing the owner.

Human clarification:

This is not only "delegate to the schema/parser/owner." That is the preferred construction pattern, but weak local validation is also in scope when local validation becomes the asserted authority for a contract.

Naming correction:

The current rules prove broad input such as `any`, `unknown`, or loose object-shaped values. They do not generally prove runtime provenance such as network, storage, or deserialization. Use "broad-input type authority" as the family name unless a future rule actually proves source-boundary provenance.

Bad framing:

- "Ban all casts."
- "Ban all broad object probing."
- "Ban all custom type predicates."

Better split:

- Casts from `any`/`unknown` to named contracts are source-boundary authority claims.
- Defensive shape probing is a mini-parser smell only when it probes broad values instead of using a schema/owner.
- Underchecked predicates are authority claims only when the predicate asserts an object contract it did not check or delegate.

Recommended default:

Keep these custom only where upstream rules are either too broad or only adjacent. Do not widen into generic assertion, member-access, or predicate style rules already covered by `@typescript-eslint` and related ecosystem rules. Split the family into two layers:

1. bypassing the owner/schema/parser and manufacturing authority locally;
2. token-only or near-zero local validation when the local check itself is the asserted authority.

First human grill question:

When broad input is handled with hand-written checks, is the real objection "this check is incomplete" or "this validation should have been delegated to the owning schema/parser"?

Human answer: both, with delegation as the preferred construction pattern and incomplete local validation still relevant when it claims contract authority.

Current advisory:

Claude Opus 4.8 reviewed this branch in `reports/claude-source-boundary-grill-stream-20260609.md`. It recommended:

- keep `no-appeasement-cast` ready as the deterministic layer-1 authority claim;
- sharpen `no-underchecked-type-predicate` around the degenerate zero-field claim before blocking;
- demote `no-defensive-shape-probing` to inventory/off or retire if no second drift appears, because current evidence overlaps upstream unsafe-member rules too much.

Next human grill question:

For the underchecked/probing layer, should antidrift block only the degenerate zero-field authority claim, while keeping "checked some, maybe not enough" cases as inventory? Or do we accept a heuristic sufficiency threshold as blocking?

### One-Owner Type And Model Contracts

Rules:

- `antidrift/no-structural-type-fork`
- `antidrift/no-canonical-model-fork`
- `antidrift/no-inline-structural-type-at-use-site`
- `antidrift/no-status-literal-in-type`

Human problem:

Local code redefines a contract that already has an owner, creating duplicate shapes that drift independently.

Bad framing:

- "Ban all object type literals."
- "Ban all local aliases."
- "Ban all status strings."

Better split:

- Installed/generated type forks need TypeChecker structural comparison.
- First-party domain model forks need registry-backed owner facts.
- Inline use-site object contracts are only bad at public/boundary surfaces.
- Status literals are bad only when the registry proves an owner exists and the local context is not the owner.
- The true one-owner structural-fork family is `no-structural-type-fork` plus `no-canonical-model-fork`; inline use-site object contracts are boundary-shape hygiene, and status literals are vocabulary drift.

Recommended default:

Keep custom code where TypeChecker or registry facts prove ownership. Prefer config replacement only when the rule can be expressed readably without losing owner/boundary exceptions.

First human grill question:

Should a boundary DTO or view model be allowed to structurally overlap a domain model if it represents a real translation boundary?

Recommended answer: yes. The rule should block unowned forks, not legitimate boundary contracts.

Current advisory:

Claude Opus 4.8 reviewed this branch in `reports/claude-contracts-sql-grill-stream-20260609.md`. It challenged the family grouping: installed/generated and domain structural forks are one family with different owner sources, but inline use-site contracts and status literals are separate jobs. It also called out the installed-package sweep as weaker than generated/domain registry-backed ownership because not every exported package object type is a contract the app was meant to import.

Next human grill question:

Because structural fork matching fires on subsets, does a hand-written boundary DTO that projects four or more identical owner fields count as a fork, or only a full-shape redeclaration? For installed packages specifically, should the unconfigured all-`node_modules` sweep stay blocking, or should blocking require generated/domain/registry owner facts?

### SQL String Construction

Rule:

- `antidrift/no-sql-string-concat`

Human problem:

Code constructs SQL by interpolating values or identifiers without a parameterization, escaper, or allowlist boundary.

Bad framing:

- "Detect SQL with regex and flag every interpolation."
- "Trust function or variable names that sound safe."

Better split:

- Value interpolation should use parameters.
- Identifier interpolation needs an explicit allowlist or trusted escaper.
- Parameterized SQL tag/template systems should stay clean.
- Value interpolation and identifier interpolation have different proof burdens. Value interpolation is blockable by SQL syntax context alone; identifier interpolation needs allowlist, escaper, typed union, static map, or configured safe-member proof.

Recommended default:

Keep custom. The remaining question is stable-promotion policy: whether parser-services-only conservative findings block stable, or whether the broad inventory must learn type-aware escaper/member controls.

First human grill question:

Should type-aware safe identifier proofs be required for clean interpolation, even if that means parser-services-less projects get conservative inventory findings?

Recommended answer: yes for stable policy. Do not replace type proof with name exemptions.

Current advisory:

Claude Opus 4.8 reviewed this branch in `reports/claude-contracts-sql-grill-stream-20260609.md`. It agreed the rule should stay custom, but split the stable blocker by interpolation kind: value interpolation can block everywhere, while identifier interpolation may need different behavior when parser services are absent.

Next human grill question:

Should SQL severity split by interpolation kind: value interpolation blocks everywhere, while dynamic identifier interpolation downgrades to inventory when parser services are absent? Or do we accept conservative identifier reports as the cost of one severity?

### Nullable Positional Tuple

Rules:

- `antidrift/no-nullable-positional-tuple`

Human problem:

Nullable or optional multi-slot tuples create ambiguous positional partial state, such as `[Date | null, Date | null]`, where readers must remember which slot means what and which combinations are valid.

Bad framing:

- "Ban all tuples."
- "This is low impact, so it cannot be stable."

Recommended default:

Keep the rule narrow. The blockable signal is two or more nullable/optional tuple slots, not tuple syntax in general. Low impact affects priority, not whether the detector is true.

First human grill question:

Is nullability the actual policy boundary, or is it a proxy for any two-or-more-slot positional tuple that hides field meaning?

Recommended answer: nullability is the boundary because it creates ambiguous partial-state combinations; non-null positional tuples can still be legitimate compact data.

### Async Array Callback Control Flow

Rule:

- `antidrift/no-async-array-method`

Human problem:

Async callbacks in array methods can silently drop promises or create promise lists that are not joined.

Bad framing:

- "Ban all async callbacks in array methods."
- "Use the broad ecosystem rule even if it creates route-handler noise."

Better split:

- Never-await methods such as `forEach`, `filter`, and `some` discard callback return values.
- `map` and `flatMap` can be valid when the resulting promise list is returned, awaited, or passed to `Promise.all`.

Recommended default:

Keep custom because the configured ecosystem baseline deliberately disables the noisy `checksVoidReturn.arguments` path. Consider splitting the rule's maturity: never-await methods are deterministic; `map`/`flatMap` collection is a separate dataflow branch.

First human grill question:

Should `no-async-array-method` split promotion by branch: never-await methods can promote on deterministic evidence, while `map`/`flatMap` not-collected remains a separate evidence gate?

Recommended answer: yes. They share syntax, but the job failures and proof burdens differ.

### Authz Framework Scope

Rule:

- `antidrift/require-authz-check`

Human problem:

Express-style handlers read route params without a co-located ownership/authorization decision.

Bad framing:

- "Every route function must call authorize."
- "Every param read without a nearby function name is insecure."

Better split:

- Handler-local Express param reads are the current implemented scope.
- Middleware dominance is a control-flow/framework question.
- tRPC procedures are a separate framework shape.
- Client-only authorization is a separate boundary violation.
- A stronger future shape may be construction-pattern based: every route/action is registered through a typed policy-bearing wrapper.

Recommended default:

Do not widen the current rule until each framework scope has its own positive pattern and real drift/clean matrix.

First human grill question:

Should middleware-level authorization satisfy this rule, or do we want every mutating handler to carry an explicit local ownership check?

Recommended answer: framework middleware can satisfy authentication, but ownership checks tied to specific resources usually need local proof or a typed policy wrapper.

Current advisory:

Claude Opus 4.8 reviewed this branch in `reports/claude-deterministic-authz-ui-grill-stream-20260609.md`. It warned that absence-of-call detection is inherently fragile because authorization can live in middleware, wrappers, or higher-order handlers. The stronger direction is a positive construction pattern: route/action handlers register through an approved policy-bearing wrapper.

Next human grill question:

Should authz move from absence detection to a construction-pattern rule, where handlers must be registered through a typed policy wrapper?

### Design-System Class Strings

Rules:

- `antidrift/no-raw-tailwind-color`
- `antidrift/no-hover-translate-card`

Human problem:

App code bypasses design-system primitives by spelling visual policy directly in class strings.

Bad framing:

- "Infer design intent from component names."
- "Pretend a small regex is full design-system enforcement."

Better split:

- Raw color utilities are a token-governance problem.
- Hover translate on card-like surfaces is an interaction-policy problem.
- The string itself is the policy surface, so these do not need semantic inference, but the implementation must honestly state its extraction coverage.

Recommended default:

Keep as class-string policy only if lint is the chosen layer. Prefer making disallowed utilities unconstructable through Tailwind/theme/design-system entrypoints when possible.

First human grill question:

Is source-scanning lint the right layer for raw Tailwind colors and hover translate, or should the design-system/theme make those utilities unconstructable?

Recommended answer: use lint as a backstop, not the primary design-system control. If lint stays, the raw-color regex needs to be treated as a sampler unless it covers the project's actual token surface.

## Live Grill Order

Ask these one at a time, and update this file as decisions crystallize:

1. React split resource state: should the sharper status-triplet intent fold into coupled-setters plus a redundant-constant-cell branch? (Answered and executed: yes; the standalone rule is retired.)
2. Broad-input type authority: should only zero-field authority claims block, or can heuristic sufficiency thresholds block?
3. One-owner contracts: installed-package ownership now requires accepted `ownership.yaml` package-owner facts before blocking; projected boundary DTOs still need clean-pressure classification.
4. SQL: should value interpolation and identifier interpolation have different severity when parser services are absent?
5. Nullable tuples: is nullability the policy boundary, or any ambiguous positional tuple?
6. Async arrays: should never-await methods and `map`/`flatMap` not-collected have separate promotion bars?
7. Authz: should route authz move from absence detection to typed policy-wrapper registration?
8. Design-system class strings: should lint stay as the control, or should the theme/design system make bad utilities unconstructable?
