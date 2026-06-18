# Proposal: rewrite the lifecycle-rule proof + direction for the React-state rules

Status: implemented proof rewrite; still under-proven and default-off. Target rule: `antidrift/no-handrolled-resource-lifecycle-cells`.
Adapter: `react-state` (`tooling/antidrift/src/eslint-plugin/react-state-graph.js`).

## 1. Context — what we measured and learned

The two React-state rules (`no-handrolled-resource-lifecycle-cells`, `no-shattered-ingested-entity-state`)
were shipped on synthetic RuleTester fixtures and a cherry-picked corpus case, not real evidence.
When we finally measured:

- **Lifecycle**: a scan of 1,533 real frontend files found **102** instances of the broad
  co-mutation pattern (`broadSetterCoMutation`) but **0** of the rule's enforcement shape
  (`resourceLifecycleProof`). The enforcement proof is mis-shaped, not the pattern absent.
- **Shard**: a type-aware scan of 335 components + a wider AST detector across **two** repos
  (chaski, sudocode) found **0** real owned-entity shatters; every hit is an envelope /
  value-object / computed-result split, which the rule correctly leaves alone.

Decisions already taken (committed): shard rule demoted to inventory-only (`064142a`). Lesson:
real-corpus-first, multi-repo baseline, synthetic tests are a wiring guard not evidence.

## 2. Diagnosis — why `lifecycleProof` catches 0 of 102

`lifecycleProof` (react-state-graph.js ~:335) requires three exact value-classes via
`classifyWriteValue` (~:31):

- **boolCell**: a setter with both `trueConst` and `falseConst` — matches real code fine.
- **errorCell**: a *distinct* setter with both `nullConst` and `caughtError`, where `caughtError`
  requires the argument to be the **raw `catch` parameter identifier**. Real catch blocks call
  `setErrorCode("DATA_INVALID")` or `setErrorCode(deriveCode(err))` → classified `other` → no error cell.
- **payloadCell**: a *distinct* setter with `awaited`, requiring the **bare awaited value**. Real code
  calls `setData(resp.items)` (a member of the awaited object) → classified `other`, routed to
  `sourceMemberWrites`, never `awaited`.

The only fixture that fires is the synthetic `handrolled-resource-lifecycle.ts` (`setUsers(result)`
+ `setFailure(err)`) — exactly the shape that does not occur in the 1,533-file corpus.

## 3. Implemented rewrite (local, reuses the adapter)

Three touch points; does not change the two-layer architecture or rule wiring.

**Adapter** (`react-state-graph.js`): records setter writes that happen under a `catch` clause and records updater setters as a conservative invalidation signal. `classifyWriteValue` and `sourceMemberWrites` stay name-agnostic.

**Proof** (`lifecycleProof`): broaden two roles over `owned = frame.ownerSetters ?? frame.setters`,
on `frame.isTransition` frames only.

1. **statusCell** — unchanged: one setter with both `trueConst` and `falseConst`.
2. **errorCell** — a distinct setter with at least one write inside `catch`, of any value class (`caughtError`,
   `other`, or `nullConst`). Reset-to-null no longer required. Covers `setError(err)`,
   `setErrorCode("DATA_INVALID")`, `setErrorCode(deriveCode(err))`.
3. **payloadCell** — a distinct setter assigned either class `awaited` (direct) **or** a member of
   the awaited source via `frame.sourceMemberWrites` (e.g. `setData(resp.items)`).
4. **proven** = statusCell && errorCell && payloadCell exist and are pairwise distinct, with no owned updater setter in the transition.

**False-positive guards (kept):**

- transition required (`frame.isTransition`) — synchronous multi-setter UI cleanup stays inventory;
- `requestGuard` downgrade — abort-guarded fetches stay exempt;
- catch-anchored error is the critical guard — a happy-path `setError(null)` reset with no catch
  write does not qualify (keeps stale-while-revalidate out);
- updater payloads invalidate the proof (`classifyWriteValue` → `updater`) — keeps pagination
  (`setItems(prev => [...prev, ...p.items])`) inventory;
- distinct roles — one cohesive cell cannot fill two roles.

**Fact contract:** the implementation kept singular `payloadCell` because the proof selects the first deterministic payload setter. No schema bump was needed.

**Current acceptance set:**

- Catches the existing `handrolled-resource-lifecycle.ts` fixture and derived-catch/member-payload regression.
- Current pinned fixed-proof corpus covers 9 real diagnostics across Chaski, Sudocode, and Cloudflare Agents, including `src/frontend/crow-v2/app/(drawer)/reporting/action-items/index.tsx:78`, `frontend/src/components/executions/ExecutionView.tsx:463`, and `examples/worker-bundler-playground/src/client.tsx:76`.
- Must still IGNORE (→ inventory or nothing): stale-while-revalidate (no catch), pagination
  (updater), UI-cleanup (no transition), abort-guarded (requestGuard), owned-resource-hook
  (no local useState cells).

## 4. Direction / promotion path

The rewrite makes the proof less synthetic, but it did **not** turn broad co-mutations into blocking diagnostics. Current fixed-proof inventory checked 3,323 files across Chaski, Sudocode, Murderbox, Codebase Atlas, Opencode UI/console, Cloudflare Agents, and PowerSync; kept 230 broad co-mutation facts as inventory; and the pinned corpus now covers 9 `resourceLifecycleProof` diagnostics across Chaski, Sudocode, and Cloudflare Agents. Whether to **enable** the rule as blocking (`severity: error`) is a separate promotion decision requiring the must-catch/must-ignore set to hold cleanly across independent repos. Under-proven means default-off until then. The shard rule stays inventory-only; option B (keep a type-owner tier as a non-blocking measurement tag) and an agent-generated-corpus revisit are future, additive.

## 5. Concerns / open questions (attack these)

1. **Is the pattern actually bad?** Hand-rolling loading/error/data is extremely common; is it a
   genuine defect, a style preference, or sometimes correct (no query lib available)? The fixed-proof diagnostics need human review before any default enablement.
2. **Is "any write inside `catch`" too broad?** Could it flag components that set an error cell in
   catch but are not really a hand-rolled resource machine (e.g. fire-and-forget mutations, form
   submit handlers)? Where does errorCell over-match?
3. **payloadCell = member-of-awaited** — does reusing `sourceMemberWrites` pull in cases where the
   "payload" cells are actually independent view state seeded from one response (the envelope case
   the shard rule deliberately ignores)? Could the lifecycle rule now fire on weekly-digest *because*
   of the envelope split, conflating two different patterns?
4. **Multi-repo**: the fixed-proof positives now replicate in Sudocode and Cloudflare Agents. Do those positives survive review, and do Murderbox/form-like controls stay quiet for the right reason?
5. **Contract churn**: payloadCells + schema bump ripples through the frozen contract, manifest,
   types, consumer-monorepo, docs. Is the value worth the breaking change, or should payload stay
   singular (first sorted cell)?
6. **Should this rule even aim for enforcement**, or is its honest end-state inventory-only too —
   a measurement of "how much hand-rolled lifecycle exists" rather than a blocking guardrail?
7. **Shard rule**: keep as inventory (option A, current), restore the type-owner tier as a
   non-blocking measurement tag (option B), or delete entirely (YAGNI)?

## 6. What I am asking the reviewer to decide

- Is the rewrite spec in §3 correct and complete, or does it have a blind spot (esp. concerns 2/3)?
- Is the *direction* right — fix the proof now, defer enablement to a separate 2-repo proof-out — or
  is there a cheaper/safer path (e.g. keep inventory-only, never enforce)?
- Biggest risk we are not seeing?
