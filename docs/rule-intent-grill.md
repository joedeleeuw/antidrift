# Rule Intent Grill

Last updated: 2026-06-09.

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

## Current Grill Targets

### React Split Resource State

Rules:

- `antidrift/no-status-triplet-state`
- `antidrift/no-coupled-state-setters`
- research: `react/no-use-state-waterfall`, `react/no-effect-fetch-waterfall`

Human problem:

React async/resource state gets modeled as separate mutable facts, even when one or more facts can be derived from the resource value or lifecycle transition.

Bad framing:

- "Find data/loading/error names."
- "Find any component with N `useState` cells."
- "Prefer reducers everywhere."

Better split:

- `no-status-triplet-state` is really about derivable resource lifecycle facts.
- `no-coupled-state-setters` is about local state cells behaving like one implicit state machine.
- A behavior-based `no-status-triplet-state` likely collapses into `no-coupled-state-setters` plus a redundant-constant-cell proof: one setter writes a constant such as `false` or `null` whenever another setter receives the resource value.
- Fetch/effect waterfall is a separate data-loading architecture problem, mostly pressured by `no-raw-fetch-in-component` and React Hooks rules.

Recommended default:

Keep `no-status-triplet-state` off. Rebuild only if the detector proves React resource-lifecycle cohesion: async boundary, related setters, and evidence that at least one cell is derivable from the lifecycle state. Names can be hints, not proof. The likely implementation path is to fold the proven subset into `no-coupled-state-setters`, not to maintain a separate name-triplet rule.

First human grill question:

If a component has `data`, `loading`, and `error`, but all three are fed directly by TanStack Query or another resource hook, should antidrift ever report it?

Recommended answer: no. The problem is local mutable lifecycle modeling, not the visible words.

Current advisory:

Claude Opus 4.8 reviewed this branch in `reports/claude-react-grill-stream-auth-20260609.md`. It agreed the direction is right, but challenged the standalone rule boundary: derivability is the proof that a coupled cell is redundant, so the sharper rule may be `no-coupled-state-setters` with a redundant-constant-cell branch.

Next human grill question:

If the only deterministic proof of derivability is a setter writing one cell to a constant whenever another cell is set, should `no-status-triplet-state` retire and fold into `no-coupled-state-setters`?

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

Recommended default:

Keep custom code where TypeChecker or registry facts prove ownership. Prefer config replacement only when the rule can be expressed readably without losing owner/boundary exceptions.

First human grill question:

Should a boundary DTO or view model be allowed to structurally overlap a domain model if it represents a real translation boundary?

Recommended answer: yes. The rule should block unowned forks, not legitimate boundary contracts.

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

Recommended default:

Keep custom. The remaining question is stable-promotion policy: whether parser-services-only conservative findings block stable, or whether the broad inventory must learn type-aware escaper/member controls.

First human grill question:

Should type-aware safe identifier proofs be required for clean interpolation, even if that means parser-services-less projects get conservative inventory findings?

Recommended answer: yes for stable policy. Do not replace type proof with name exemptions.

### Deterministic Narrow Syntax

Rules:

- `antidrift/no-nullable-positional-tuple`
- `antidrift/no-async-array-method`

Human problem:

The source shape itself is the bug-prone construction.

Bad framing:

- "This must be stable only after endless repo mining."

Better split:

- Nullable multi-slot tuples are ambiguous positional partial state.
- Async callbacks in array methods are control-flow hazards, with `.map`/`.flatMap` needing a clear `Promise.all` or loop story.

Recommended default:

Treat these as narrow deterministic rules. A second real program is useful, but if the detector is precise and ecosystem overlap is only partial, a documented one-repo evidence exception may be acceptable.

First human grill question:

For deterministic syntax rules, is low impact enough reason to keep them not-stable, or should stability be allowed once false-positive risk is demonstrably low?

Recommended answer: low impact should affect priority, not truth. Stability should depend on correctness and evidence, not perceived glamour.

### Authz Framework Scope

Rule:

- `antidrift/require-authz-check`

Human problem:

Server handlers read request identity, route params, or tenant-scoped inputs without an ownership/authorization decision in the same boundary.

Bad framing:

- "Every route function must call authorize."
- "Every param read without a nearby function name is insecure."

Better split:

- Handler-local Express param reads are the current implemented scope.
- Middleware dominance is a control-flow/framework question.
- tRPC procedures are a separate framework shape.
- Client-only authorization is a separate boundary violation.

Recommended default:

Do not widen the current rule until each framework scope has its own positive pattern and real drift/clean matrix.

First human grill question:

Should middleware-level authorization satisfy this rule, or do we want every mutating handler to carry an explicit local ownership check?

Recommended answer: framework middleware can satisfy authentication, but ownership checks tied to specific resources usually need local proof or a typed policy wrapper.

## Live Grill Order

Ask these one at a time, and update this file as decisions crystallize:

1. React split resource state: should the sharper status-triplet intent fold into coupled-setters plus a redundant-constant-cell branch?
2. Broad-input type authority: should only zero-field authority claims block, or can heuristic sufficiency thresholds block?
3. One-owner contracts: where do boundary DTOs/view models stop being forks?
4. SQL: should type-aware safe identifier proof be required for clean dynamic identifiers?
5. Deterministic syntax: can precise low-risk rules become stable with less replication?
6. Authz: which framework scopes are in, and what counts as local proof?
