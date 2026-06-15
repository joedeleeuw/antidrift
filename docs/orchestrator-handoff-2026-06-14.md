# Orchestrator Handoff: Rule Proof Reassessment

Date: 2026-06-14

## Current Objective

Antidrift is already a distributable guardrail package. The current objective is to make its distributable policy surface honest by separating:

- what ecosystem tools already own,
- what local lint rules can actually prove,
- what needs semantic/type/registry proof,
- what belongs in agent-ops scripts and hooks.

The immediate work is not broad rule expansion. It is tightening the rule taxonomy so future implementation does not promote inventory heuristics as blocking proof.

## Current Worktree State

Intentional untracked local data should be left alone:

- `.sudocode/`
- `data/`

Edited in the current pass:

- `docs/rule-roadmap.md`
- `docs/rule-equivalence-audit.md`
- `docs/policy-coverage.md`
- `docs/rule-status-registry.md`
- `docs/stable-promotion-inventory.md`
- `docs/roadmap.md`
- `policy/registries/rules.yaml`
- `docs/orchestrator-handoff-2026-06-14.md`

No source-rule implementation has been changed yet in this pass.

## Corrected Decision

Do not treat "AST can find this" as "AST can prove this."

The important correction is the React resource-state family:

- `antidrift/no-status-triplet-state` is name-based inventory only.
- `data/loading/error` names are hints, not proof.
- Standalone status-triplet blocking should retire.
- The useful proof belongs inside `antidrift/no-handrolled-resource-lifecycle-cells`.
- Broad multi-setter co-mutation is also inventory unless it proves a lifecycle transition problem.
- The blocking branch should be a redundant-constant-cell transition proof, for example one setter receives a resource value while sibling lifecycle cells are reset to constants such as `false`, `null`, or `undefined`.

Short version: syntax finds suspects; semantic proof earns enforcement.

## Authority Index Framing

The registry should be treated as a project authority index, not a hardcoded dependency list.

For consumers, the default location should be:

```txt
policy/registries/*.yaml
```

The shareable config already defaults to `policyDir: "policy"` and allows an override for repos that need another location. Keep registry contents consumer-owned; the package should ship rules, validation, and starter templates.

For package-type ownership specifically, `policy/registries/ownership.yaml` is now consumed by `antidrift/no-structural-type-fork` through `packageTypeOwners`. Keep the file optional; absent registry means installed-package matches remain inventory/proposal only.

For owned types:

- TypeChecker package scans may inspect all loaded `node_modules` exports.
- A structural match to a package export is inventory/discovery by default.
- Blocking requires accepted ownership evidence, such as generated-source configuration, domain owner configuration, generated wrapper provenance, existing imports/derivations from the package type, SDK return provenance, or a human-approved package-owner fact.
- Do not hardcode Firebase, Convex, or other ecosystem packages into Antidrift itself.
- The desired product loop is analytics first, proposed authority facts second, enforcement third.

Example: the detector can discover that a local type matches `firebase/auth#User`; the authority index is what says this repo treats `firebase/auth#User` as the owner and should import or derive from it.

## Files To Read First

1. `docs/rule-roadmap.md`
   - Proof buckets were updated.
   - `no-handrolled-resource-lifecycle-cells` now lives in semantic source/type/provenance proof for blocking branches.
   - `no-status-triplet-state` is default-off / pending retirement.
   - The registry is now framed as an authority index, not a dependency allowlist.

2. `policy/registries/rules.yaml`
   - `react/no-status-triplet-state` now says do not enable standalone.
   - `antidrift/no-handrolled-resource-lifecycle-cells` now says implement redundant-constant-cell as the blocking core.

3. `tooling/antidrift/src/eslint-plugin/index.js`
   - Current `ruleNoStatusTripletState()` is still name-group inventory.
   - Current `ruleNoCoupledStateSetters()` reports broad co-mutation and has not yet gained the redundant lifecycle-cell branch.

4. `tooling/antidrift/src/eslint-plugin/index.test.mjs`
   - Current tests still exercise standalone status-triplet behavior.
   - Tests will need adjustment when retiring/folding the rule.

## Next Execution Sequence

1. Verify the documentation-only alignment.
   - Run `pnpm policy:check-registries`.
   - Run `pnpm policy:check-rule-surface`.
   - If either fails, fix registry/docs consistency before touching rule code.

2. Implement the coupled-state semantic branch.
   - Bind React `useState` setter names to their component-owned state cells.
   - Within a handler/effect/async transition, group setter calls by component frame.
   - Report only the proven branch where multiple related setters encode one lifecycle transition.
   - Start with conservative proof:
     - one setter receives a non-constant resource-like value, awaited result, callback argument, or caught error;
     - at least one sibling setter is assigned a lifecycle constant such as `false`, `true`, `null`, `undefined`, or a string/enum phase;
     - the calls occur in the same transition block or same branch of an async lifecycle.
   - Keep broad co-mutation findings as inventory unless this proof holds.

3. Retire or demote standalone status-triplet enforcement.
   - Keep the rule off while migration happens.
   - After the coupled-setters branch covers the intended proof, remove active promotion language for `no-status-triplet-state`.
   - Consider locking it in retired rules once tests and docs are updated.

4. Reassess ecosystem/delegated rows only after the React correction lands.
   - Import cycles stay delegated to `import-x/no-cycle`.
   - Layer/deep imports stay delegated to `eslint-plugin-boundaries`.
   - Test integrity stays delegated to `@vitest/eslint-plugin`.
   - Inline disable reasons stay delegated to `@eslint-community/eslint-comments` plus `@typescript-eslint/ban-ts-comment`.
   - Agent-ops items stay policy-script/hook/PR-bot work, not ESLint custom rules.

5. For owned package types, build analytics before blocking.
   - Keep unconfigured all-package structural matches as inventory.
   - Generate candidate authority facts from existing imports, owner-type derivations, SDK return provenance, generated wrappers, and repeated forks.
   - Enforce only accepted/generated authority facts.

6. Verify before handoff or commit.
   - Run `pnpm policy:verify-session`.
   - If implementation changes are made, also run the focused ESLint plugin tests.

## Implementation Cautions

- Do not match only names such as `data`, `loading`, and `error` for blocking severity.
- Do not block every handler with multiple setters. Forms and UI controls often update multiple cells correctly.
- Do not infer domain ownership from strings alone. Registry absence means no registry proof.
- Do not treat every npm package export as an owner. Package structural matches are analytics unless this repo accepts the package type as authoritative.
- Do not port agent-ops failures into ESLint. Stale verification, diff-scope creep, runtime proof, tool permissions, and generated policy edits need scripts/hooks.
- Do not edit generated policy artifacts directly.

## Useful Commands

```sh
pnpm policy:check-registries
pnpm policy:check-rule-surface
pnpm test -- tooling/antidrift/src/eslint-plugin/index.test.mjs
pnpm policy:verify-session
```

## Current Open Question

How narrow should the first redundant-constant-cell proof be?

Recommended starting point: narrow. Only block when the rule can show the same transition writes resource data and resets sibling lifecycle cells to constants. Everything broader should be inventory until real corpus classification proves it is safe.
