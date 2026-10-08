# Proposal: `antidrift baseline` — adoption ratchet as a first-class command

Status: draft for review. Not implemented. Proposed target release: 0.15.0;
this is not a publication or implementation commitment.

## Problem

Adopting strict rules all at once on a mature repo can produce many findings on
pre-existing code. Those findings need intent review: a diagnostic is not proof
of a defect, and a registry promotion label is not fresh consumer FP evidence.
A baseline must not turn detector mistakes into accepted historical debt.

Homer implements a consumer ratchet in `scripts/oxlint/antidrift-ratchet.mjs`
and per-file overrides in `oxlint.config.ts`. This proposal would package a
count-based adoption budget rather than require each consumer to build one.
The chosen representation has a deliberate limitation: it prevents growth in
per-rule, per-file counts, not the introduction of every new finding identity.

## Core API — two commands, one file, one doctrine

```sh
antidrift baseline            # initial adoption: record reviewed current budgets
antidrift check               # gate: full repo, selected rules at error
antidrift check --baseline    # gate: compare current counts to committed budgets
antidrift baseline --update   # paydown: shrink/remove existing budgets only
```

This proposal has no diff mode, severity tiers, expiry, or auto-fix.
`check-changed` keeps its separate policy-surface job.

Initial adoption is distinct from paydown. `baseline --update` must reject a
new `(rule, file)` key or an increased count; it must not regenerate a larger
baseline and thereby silently forgive new debt. Later adoption of another rule
requires an explicit reviewed adoption operation, whose interface remains open.

## Baseline file format

```jsonc
// .antidrift-baseline.json (committed)
{
  "version": 1,
  "rules": {
    "antidrift/no-structural-type-fork": {
      "apps/api/lib/tools.ts": 3,
      "apps/machine/src/cli.ts": 1,
    },
  },
}
```

These are per-`(rule, file)` count budgets, not finding identities. Line numbers
churn on unrelated edits; symbol fingerprints require rule-specific stable
identity. Counts avoid that cost but cannot establish identity continuity.

For example, removing one finding and introducing another for the same rule in
the same file leaves a budget of three unchanged. Both `check --baseline` and a
count-only update accept that replacement. The command must not describe this
as a guarantee that all new findings fail, nor claim to name which finding is
new from counts alone. A strict no-new-instance guarantee would require stable
identities or another explicitly reviewed change-relative mechanism.

## The doctrine becomes mechanical: counts only go down

The gate compares a complete current census with the committed baseline:

1. **Actual count exceeds its budget, or a nonzero count has no key** → fail,
   naming the rule, file, and count increase. Aggregate debt cannot grow within
   that key; this does not identify a newly introduced instance.
2. **Actual count is below its budget** → fail with a stale-budget message,
   such as "expected 3, found 2 — run `antidrift baseline --update`". The
   down-only update shrinks the budget.
3. **A budget's actual count is zero** → the same stale-budget failure; a
   down-only update removes the key.
4. **Actual count equals its budget** → pass, subject to the equal-count
   replacement limitation above.

Fresh paydown cannot leave an oversized budget that silently re-admits debt.
This property does not eliminate replacement within an unchanged budget.
There is no verified comparison here with other tools' baseline guarantees.

Adoption flow: review true findings and detector false positives separately →
record reviewed budgets → commit → enforce selected rules through the baseline
check → shrink budgets until the baseline is empty and deletable. Do not adopt
an unproven detector merely to obtain an empty census.

## Scope boundaries and acceptance evidence

- The initial proposal covers Oxlint findings. The ESLint TypeChecker tier can
  use the same rule-keyed format once diagnostic counting and intent review are
  established; this is not proof that the two runtimes already interoperate.
- A complete census uses pinned rule implementations, explicit rule options and
  owner authorities, a known file-selection set, and consistent generated-file
  exclusions. An inert rule with missing authority is not a clean result.
- Partial, failed, or unparsable lint output must fail closed before any baseline
  comparison or write. A rules/config/source-selection change must be reported
  as a changed measurement contract, not mistaken for debt paydown. The exact
  manifest representation remains a design question.
- Rule/file renames, moved findings, and newly adopted rules require explicit
  treatment; the down-only update cannot create replacement keys silently.
- No auto-fix. Baseline is inventory and gating, not remediation or rule proof.

## Relationship to existing doctrine

- Pins-only-down is Homer doctrine; this packages count-budget paydown.
- `policy/check-changed` blocks protected configuration/generated changes without
  policy-source changes or an explicitly declared policy task; unchanged.
- Invalid configuration and incomplete measurements fail loudly. A stale
  baseline is a gate failure, never a silent pass.
- Package default-off status remains independent of consumer rule adoption.

## Review questions

1. Is a count budget with documented equal-count replacement acceptable, or is
   the required outcome a strict no-new-instance gate with finding identities?
2. How should later reviewed rule adoption and rule/file renames be represented
   without turning `--update` into a debt-growth escape hatch?
3. What pins the measurement contract, and what constitutes a complete census
   across Oxlint and the checker tier?
4. Which existing policy module should own this, and how does consumer review
   distinguish genuine historical drift from detector false positives?
