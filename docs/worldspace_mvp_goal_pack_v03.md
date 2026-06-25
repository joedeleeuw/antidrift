

---

<!-- Source: README.md -->

# Worldspace Agent-Playable Evaluation Adapter — MVP Archive v0.3

This archive reorients the prior broad capability plan into an additive MVP ladder that can be handed to a high-reasoning Codex agent for implementation.

The core direction:

```text
Do not rebuild existing product systems.
Wrap what exists.
Add the missing perception → action-result → replay/evidence → scenario/oracle/report spine one MVP at a time.
Require adversarial subagent review at every stage.
Use TITAN-style testing pressure throughout: functional correctness, coverage/exploration, and oracle-backed bug/friction detection.
```

## Assumed existing systems to verify, not rebuild

The orchestrating agent claimed the repo already has these systems. Treat them as claims until MVP 0 proves them with source refs and runnable evidence.

| System | Expected role in this plan | Build stance |
|---|---|---|
| `CHANGE_SOURCE` | Semantic claim↔act linkage, verdicts, witnesses | Wrap as first-class telemetry |
| `FOG_STATE` | Region fog bands driven by semantic verdicts | Wrap and evaluate consistency |
| Screenshot save/load | State-bearing screenshot/save object | Use as state anchor, not full replay |
| Pins / notes | Existing spatial memory annotations | Use as memory/evidence inputs |
| `world.render` / world model | Existing world representation | Adapt to registry, do not replace |
| WebGL2 / MRT-capable renderer | Render-grounded diagnostic view foundation | Extend with same-camera diagnostic passes |
| On-demand RGB capture | Player-facing retina baseline | Wrap into timestamped frame refs |
| Walk harness | Existing embodied movement path | Wrap with action-result tracing |
| CDP command/signal protocol | Existing transport | Reuse as action/event transport |
| `serializeXray` | Existing JSON state stream | Freeze as JSON-only ablation arm |

## Contents

```text
README.md
MVP_LADDER.md
CHANGELOG_v03.md
ARCHIVE_MANIFEST.md

handoff/
  SEND_TO_ORCHESTRATING_AGENT.md

goal-cards/
  00-mvp-0-wrap-map-and-adapter-spine.md
  01-mvp-1-observation-baseline-frame-envelope.md
  02-mvp-2-action-result-tracing.md
  03-mvp-3-keystone-hot-region-scenario.md
  04-mvp-4-object-registry-and-nav-probes.md
  05-mvp-5-rgb-visual-replay-windows.md
  06-mvp-6-render-grounded-diagnostic-vision.md
  07-mvp-7-oracle-bank-and-layer-4-report.md
  08-mvp-8-ablation-and-regression-harness.md
  09-optional-mvp-9-titan-style-campaign-runner.md

reviews/
  PER_MVP_ADVERSARIAL_STAGE_GATE.md

.codex/agents/
  worldspace-code-mapper.toml
  worldspace-adversarial-reviewer.toml
  worldspace-qa-runner.toml
  worldspace-visual-validator.toml
  worldspace-research-checker.toml
  titan-oracle-reviewer.toml

schemas/
  frameEnvelope.ts
  actionTrace.ts
  evidenceWindow.ts
  layer4Finding.ts
  scenarioResult.ts

oracles/
  ORACLE_BANK.md

ablations/
  ABLATION_MATRIX.md

templates/
  WRAP_MAP_TEMPLATE.md
  CAPABILITY_MANIFEST_TEMPLATE.md
  RUN_REPORT_TEMPLATE.md

research/
  RESEARCH_ANCHORS.md
```

## How to use this with Codex

Run the MVP goal cards sequentially. Do not ask Codex to implement all MVPs at once.

For each MVP:

1. Paste only that MVP goal card into Codex.
2. Require it to run the MVP smoke command or produce the blocker report.
3. Require subagent review using `reviews/PER_MVP_ADVERSARIAL_STAGE_GATE.md`.
4. Do not proceed until blockers are fixed or explicitly deferred.
5. Preserve every existing product system proven in the WRAP-MAP.

## Reasoning effort note

Use GPT-5.5 with the highest reasoning effort available in your Codex environment. If your local config accepts `xhigh`, use it for the main implementation agent and adversarial reviewer. If not, use the highest supported setting.

## Non-negotiables

```text
- No greenfield simulator.
- No duplicate transport if CDP already works.
- No screenshot-save/load rebuild.
- No pin/note/fog/change-source rebuild.
- No x-ray from JSON replotting.
- No calibrated human-fun claims before a future human layer.
- No high-severity finding without resolvable evidence refs.
```

## Keystone acceptance gate

The first real product-specific acceptance gate is MVP 3:

```text
Navigate to a hot/deviation region selected from semantic CHANGE_SOURCE verdict+witness data, then emit a scenario result and later a Layer-4 finding grounded in that verdict/witness, action trace, frame refs, replay window, and final reached/not-reached outcome.
```

This proves the loop that matters for this app:

```text
semantic code/world change → region state/fog → embodied navigation/discovery → evidence-backed playability/evaluation comment
```


---

<!-- Source: CHANGELOG_v03.md -->

# Changelog v0.3

## What changed from the prior goal pack

The prior artifact was a broad capability pack. This version is an implementation-oriented MVP ladder.

## Major changes

1. **Shifted from capability map to MVP ladder.**
   - Each goal now lands a playable/evaluable vertical slice.
   - Each stage leaves the repo in a useful state.

2. **Moved adversarial subagent review into every MVP.**
   - Review is now a stage gate, not a final cleanup pass.
   - QA, adversarial review, visual validation, research consistency, and TITAN-oracle review are invoked as appropriate per stage.

3. **Preserved existing systems as boundaries.**
   - Screenshot save/load, pins, notes, fog, change-source, world model, walk harness, CDP, RGB capture, and serializeXray are treated as existing claims to verify and then wrap.

4. **Made `serializeXray` the JSON-only ablation arm.**
   - It is not the render-grounded x-ray.
   - It is the baseline against which RGB/x-ray/memory arms are compared.

5. **Introduced the semantic hot-region scenario as the keystone gate.**
   - Success depends on using CHANGE_SOURCE verdict+witness data, not hard-coded domain names.

6. **Integrated TITAN influence throughout.**
   - Every MVP includes functional-correctness, coverage/exploration, oracle, or trace-memory pressure.
   - TITAN remains an evaluation/testing influence, not a target architecture to clone.

7. **Separated state anchors from replay evidence.**
   - Screenshot save/load is preserved as a state anchor.
   - Replay/evidence windows are additive and time-bounded.

8. **Kept Layer 4 agent-only.**
   - Layer 4 reports fun/friction/polish/learning hypotheses from proxies and evidence.
   - Human calibration remains a future Layer 5.


---

<!-- Source: MVP_LADDER.md -->

# MVP Ladder — Additive Agent-Playable Evaluation Adapter

The ladder is designed to keep implementation unified while adding agent playability piecemeal.

Do not build isolated systems. Every MVP should connect to the same spine:

```text
existing world systems
  → adapter boundary
  → FrameEnvelope
  → action trace
  → evidence window
  → scenario result
  → oracle findings
  → report / ablation
```

## MVP summary

| MVP | Adds | Agent playability unlocked | How success is known | TITAN pressure |
|---|---|---|---|---|
| 0. Wrap-map + adapter spine | Repo truth audit, capability manifest, adapter namespace | None; prevents waste | Existing systems classified with source/test proof | State-abstraction inventory |
| 1. Observation baseline | FrameEnvelope from existing state, screenshot refs, serializeXray, fog, change-source | Agent can observe through current semantic state | One command emits timestamped envelope with explicit missing fields | State perception |
| 2. Action-result tracing | Wrapper over existing walk/CDP commands | Agent can act and know what happened | Move/turn/wait produce before/after traces and no-op detection | Action prioritization + trace memory |
| 3. Hot-region scenario | Scenario runner tied to CHANGE_SOURCE verdict+witness | Agent attempts the core product loop | Scenario selects semantic target and emits reached/not-reached evidence | Functional correctness |
| 4. Registry + nav probes | Object registry adapter, screen projection, clearance probes | Agent reasons about objects and reachable space | IDs/projections/probes work or fail explicitly | Richer abstraction + action prioritization |
| 5. RGB replay windows | Time-bounded visual evidence | Agent can cite what player saw | Replay refs resolve to RGB/actions/events/witnesses | Trace memory/reflection |
| 6. Diagnostic vision | Same-camera x-ray/depth/object-ID/affordance views | Agent reasons spatially from render-grounded views | Diagnostic image is live-rendered, aligned, toggleable | High-dimensional state abstraction |
| 7. Oracles + Layer-4 report | Conservative findings and report artifact | Agent reports playability/friction/polish/learning hypotheses | High-severity findings have evidence refs | LLM/oracle-backed bug detection |
| 8. Ablation harness | JSON/RGB/x-ray/memory comparison | System can test whether x-ray/images/memory help | Same scenario runs under isolated perception arms | Component-value validation |
| 9. Optional TITAN-style campaign runner | Multi-scenario campaign, coverage map, bug triage | Long-running evaluation campaign | Report covers completion, coverage, oracle findings, regressions | Holistic testing framework |

## Stage gate applies to every MVP

Before marking an MVP complete:

```text
- Run the MVP smoke command or produce the blocker report.
- Run adversarial subagent review.
- Run QA subagent review.
- Run visual validation when render/frame outputs exist.
- Run research/TITAN review when playability, fun, oracle, or evaluation claims appear.
- Fix blockers or explicitly defer them with evidence.
```

## Success language

Use these words:

```text
- observed
- verified
- evidence-backed
- proxy
- hypothesis
- oracle candidate
- replayable
- bounded
- partial
- unsafe-to-assume
```

Avoid these words before Layer 5:

```text
- proves fun
- human-validated
- calibrated enjoyment
- definitive playability
- complete coverage
```


---

<!-- Source: handoff/SEND_TO_ORCHESTRATING_AGENT.md -->

# Handoff to Orchestrating Agent — v0.3 MVP Reorientation

Regenerate the implementation plan as an additive MVP ladder, not a broad capability build.

Your prior handoff usefully narrowed the problem: this is **not greenfield**. The repo may already own screenshot save/load, pins, notes, fog, semantic change-source, world model, CDP, walk harness, RGB capture, MRT capability, and serializeXray. Treat those as claims to verify, then wrap them. Do not rebuild them.

## Implementation direction

```text
Build the missing perception/evidence/evaluation spine around the existing worldspace.
```

The spine is:

```text
existing world systems
  → adapter boundary
  → FrameEnvelope
  → action-result traces
  → replay/evidence windows
  → scenario runner
  → conservative oracles
  → Layer-4 report
  → ablation harness
```

## MVP order

1. MVP 0 — WRAP-MAP and adapter spine
2. MVP 1 — Observation baseline / FrameEnvelope
3. MVP 2 — Action-result tracing
4. MVP 3 — Keystone semantic hot-region scenario
5. MVP 4 — Object registry adapter and nav probes
6. MVP 5 — RGB visual replay windows
7. MVP 6 — Render-grounded diagnostic vision
8. MVP 7 — Oracle bank and Layer-4 report
9. MVP 8 — Ablation and regression harness
10. Optional MVP 9 — TITAN-style campaign runner

## Keystone gate

The first product-specific proof point is:

```text
Navigate to a hot/deviation region selected from CHANGE_SOURCE verdict+witness data, then produce evidence that cites the semantic verdict/witness, action trace, frame or screenshot refs, and reached/not-reached scenario result.
```

That gate proves the product loop:

```text
code/world semantic signal → region/fog state → embodied discovery/navigation → evidence-backed playability/evaluation comment
```

## TITAN influence

Use TITAN as recurring testing pressure, not target architecture.

For every MVP, ask:

```text
Functional correctness: what task can now complete or fail with evidence?
Coverage/exploration: what new state/space/region can now be observed or traversed?
Oracle/bug detection: what conservative failure mode can now be detected?
Trace memory/reflection: what time-bounded evidence can now be cited?
```

## Subagent review

Run adversarial review at every MVP stage, not only at the end.

Required reviewers by stage:

```text
- MVP 0+: code mapper and adversarial reviewer
- MVP 1+: QA runner
- MVP 5+: visual validator
- MVP 6+: research checker and TITAN oracle reviewer
```

Preserve reviewer disagreement. Resolve by source refs, test output, and replay artifacts.

## Non-negotiables

```text
- Do not invent a new transport if CDP works.
- Do not replace the world model.
- Do not rebuild screenshot save/load, pins, notes, fog, or change-source.
- Do not call serializeXray the render-grounded x-ray.
- Do not produce an x-ray by replotting JSON.
- Do not claim calibrated human fun in Layer 4.
- Do not mark success without concrete commands, artifacts, or blocker reports.
```


---

<!-- Source: reviews/PER_MVP_ADVERSARIAL_STAGE_GATE.md -->

# Per-MVP Adversarial Stage Gate

Run this review before marking any MVP complete.

The goal is not to make the plan more elaborate. The goal is to prevent false completion, accidental rebuilds, unsupported fun claims, and evidence gaps.

## Required stage sequence

```text
1. Main implementer finishes the thinnest MVP slice.
2. QA runner executes smoke/test commands and records output.
3. Adversarial reviewer checks scope, boundaries, and evidence.
4. Visual validator runs if frames/render outputs exist.
5. Research checker runs if claims involve playability, fun, Layer-4 evaluation, or Codex/TITAN framing.
6. TITAN oracle reviewer runs from MVP 3 onward, or earlier if oracles are introduced.
7. Main implementer fixes blockers or records explicit deferrals.
8. Completion report lists fixed/deferred/rejected reviewer findings.
```

## Universal adversarial checklist

```text
- Did the implementation rebuild a system classified as owned?
- Did it invent a new transport instead of reusing CDP?
- Did it mutate serializeXray instead of preserving it as JSON-only baseline?
- Did it represent missing fields explicitly?
- Did it produce concrete artifacts, not only logs or prose?
- Are evidence refs resolvable?
- Is every high-severity claim backed by evidence?
- Are assumptions separated from verified facts?
- Are blocked capabilities reported with the smallest next proof needed?
```

## Visual validation checklist

Use when MVP includes RGB, screenshot, replay, x-ray, depth, ID, affordance, or visual/polish claims.

```text
- Do RGB and diagnostic views share the same camera pose?
- Are frame refs resolvable?
- Does diagnostic output come from live rendering, not JSON replotting?
- Are screenshots visually coherent after save/load?
- Does any evidence image contradict the text report?
- Are cadence/resolution/storage tradeoffs documented?
```

## Research / playability language checklist

```text
- Are “fun” claims phrased as hypotheses or proxies?
- Are findings grounded in functional completion, coverage/exploration, oracle-detected friction, trace evidence, or visual evidence?
- Does the report avoid human-calibrated enjoyment claims before Layer 5?
- Is TITAN used as testing influence, not cloned architecture?
```

## TITAN-inspired review checklist

For each MVP, ask:

```text
Functional correctness:
- What task can now complete or fail with evidence?
- Is there an explicit reached/not-reached/inconclusive result?

Coverage/exploration:
- What new region/object/state can now be observed or traversed?
- Is coverage grounded in repo-visible entities?

Oracle detection:
- What failure mode can now be detected conservatively?
- Does the oracle have positive/negative examples or captured proof?

Trace memory/reflection:
- What time-bounded evidence can now be cited?
- Can the evidence be reopened/resolved?
```

## Completion decision

An MVP is complete only if one of these is true:

```text
- The smoke command/test passes and required artifacts exist.
- The MVP is explicitly marked blocked, with source refs checked, command output, blocker, and smallest next input needed.
```

Do not mark complete based on “implementation appears correct.”


---

<!-- Source: goal-cards/00-mvp-0-wrap-map-and-adapter-spine.md -->

# MVP 0 — WRAP-MAP and Adapter Spine

## Codex goal

```text
/goal Implement MVP 0: produce a repo-grounded WRAP-MAP and create the thinnest adapter spine for the worldspace agent-playability/evaluation pipeline, verified by source refs, existing commands/tests where available, a capability manifest artifact, and an adapter namespace/module with no behavior changes, while preserving all existing screenshot save/load, pins/notes, fog, CHANGE_SOURCE, world model, walk harness, CDP protocol, on-demand RGB capture, MRT renderer capability, and serializeXray behavior. Treat every claimed existing system as a hypothesis until verified. Between iterations, verify one existing system at a time and classify it as owned, partial, missing, or unsafe-to-assume. Before completion, run code-mapper, QA, and adversarial subagent review. If any claimed existing system cannot be found or safely exercised, stop with the source locations checked, command output, blocker, and smallest next proof needed.
```

## Outcome

The repo has a clear map of what exists, what should be wrapped, what is missing, and where the adapter should live.

## Verification surface

Produce these artifacts:

```text
- WRAP_MAP.md
- capability-manifest.json or equivalent
- adapter module/namespace placeholder
- command/test log for any runnable existing systems
- reviewer notes from subagents
```

## Existing systems to verify

```text
- CHANGE_SOURCE verdict+witness path
- FOG_STATE / semantic fog bands
- screenshot save/load / SaveObject / screenshot refs
- pins and notes
- world model / world.render / resolveWorldAt or equivalent
- WebGL2/MRT capability
- on-demand RGB capture
- walk harness
- CDP commands/signals
- serializeXray JSON stream
```

## How success is known

```text
- Every claimed existing system has a source ref, command proof, test proof, or explicit unsafe-to-assume mark.
- Existing systems are labeled wrap/reuse/extend/do-not-touch.
- Adapter boundary exists without changing product behavior.
- No greenfield replacement appears.
- Adversarial reviewer confirms the task did not rebuild owned systems.
```

## TITAN pressure

State-abstraction inventory. This MVP defines the observability surfaces that later become task-completion, coverage, trace-memory, and oracle inputs.

## Stage gate

Run `reviews/PER_MVP_ADVERSARIAL_STAGE_GATE.md` with at least:

```text
- worldspace-code-mapper
- worldspace-adversarial-reviewer
- worldspace-qa-runner
```


---

<!-- Source: goal-cards/01-mvp-1-observation-baseline-frame-envelope.md -->

# MVP 1 — Observation Baseline / FrameEnvelope

## Codex goal

```text
/goal Implement MVP 1: add a canonical FrameEnvelope emitted from existing worldspace systems, verified by a smoke command that captures one timestamped envelope containing available player/camera pose, region/fog state, CHANGE_SOURCE verdict+witness when present, screenshot/world-state ref, pins/notes summary when present, serializeXray baseline ref, recent events if available, and explicit unavailable reasons for missing fields, while preserving existing screenshot save/load, fog, pins/notes, world model, CDP, RGB capture, and serializeXray behavior. Use existing repo surfaces for state and capture rather than inventing a parallel observer. Between iterations, wire the thinnest source-backed fields first and add optional fields behind capability flags. Before completion, run QA and adversarial subagent review. If required state sources are ambiguous, emit a partial envelope and document the exact missing source contract.
```

## Outcome

A downstream agent can observe the world through a consistent timestamped product without needing to understand repo internals.

## Verification surface

```text
- `capture-frame-envelope` command, test, or equivalent harness
- one saved FrameEnvelope JSON artifact
- schema/type definition
- before/after proof that existing screenshot load and serializeXray still work
```

## Required envelope fields

```text
- runId
- frameId
- timestampMs
- player pose if available
- camera pose if available
- region/fog state if available
- CHANGE_SOURCE verdict/witness refs if present
- screenshot/world-state ref
- serializeXray ref or embedded baseline summary
- pins/notes summary if available
- capability flags
- unavailableReasons
```

## How success is known

```text
- A single command emits valid JSON with stable field names.
- Existing JSON-only baseline is preserved as serializeXray.
- Missing fields are explicit, not silently omitted.
- CHANGE_SOURCE verdict/witness data is first-class when available.
- FrameEnvelope can be stored and cited by later artifacts.
```

## TITAN pressure

State perception and abstraction. The FrameEnvelope is the state abstraction that later supports functional checks, coverage/exploration, and bug oracles.

## Stage gate

Run:

```text
- worldspace-qa-runner
- worldspace-adversarial-reviewer
- worldspace-code-mapper if any source ownership is uncertain
```


---

<!-- Source: goal-cards/02-mvp-2-action-result-tracing.md -->

# MVP 2 — Action-Result Tracing over Existing Controls

## Codex goal

```text
/goal Implement MVP 2: wrap the existing walk/CDP control path with action-result tracing, verified by a scenario or smoke command that executes at least move, turn, and wait, and records actionId, before/after FrameEnvelope refs or pose snapshots, duration, distance moved, no-op detection, emitted events/signals, and conservative success/failure reason, while preserving current manual controls, walk harness behavior, CDP commands/signals, and screenshot save/load. Use existing transport and control surfaces; do not invent a new action protocol unless the WRAP-MAP proves no usable transport exists. Between iterations, trace passive before/after telemetry first, then classify outcomes conservatively. Before completion, run QA and adversarial subagent review. If collision or blockage signals are unavailable, do not fake them; record unknown and report the smallest safe probe needed.
```

## Outcome

The system can say what an action attempted and what changed afterward.

## Verification surface

```text
- action-trace schema/type
- smoke command output containing at least move, turn, wait traces
- no-op movement fixture or captured example if possible
- regression proof that existing controls still work
```

## Required trace fields

```text
- actionId
- action type and parameters
- startedAtMs / endedAtMs
- before pose or FrameEnvelope ref
- after pose or FrameEnvelope ref
- distanceMovedM if available
- yaw/pitch delta if relevant
- events/signals emitted
- success boolean or tri-state success/failed/inconclusive
- failureReason or unknown
- confidence
```

## How success is known

```text
- Every traced action has before/after evidence.
- No-op movement can be detected from before/after pose even if collision reasons are unknown.
- Action traces can be linked to later scenario results and evidence windows.
- Existing walk harness and CDP transport remain intact.
```

## TITAN pressure

Action prioritization and trace memory. This creates the data needed to evaluate not just “what did the agent do?” but “what result did the world return?”

## Stage gate

Run:

```text
- worldspace-qa-runner
- worldspace-adversarial-reviewer
```


---

<!-- Source: goal-cards/03-mvp-3-keystone-hot-region-scenario.md -->

# MVP 3 — Keystone Semantic Hot-Region Scenario

## Codex goal

```text
/goal Implement MVP 3: add the keystone semantic hot-region scenario runner, verified by a repeatable command that starts from a known screenshot/save or spawn, selects a target region from CHANGE_SOURCE verdict+witness data, attempts to navigate or manual-drive-record toward that region using the existing CDP/walk path, and emits a scenario result with reached/not-reached/inconclusive, target verdict/witness refs, action trace refs, frame or screenshot refs, final region membership or distance evidence if available, and explicit blockers, while preserving existing fog, pins/notes, screenshot save/load, serializeXray, manual controls, and world model behavior. Between iterations, make the scenario observable before making it autonomous. Before completion, run QA, adversarial, and research/TITAN subagent review. If autonomous navigation is blocked, ship a manual-drive evidence-recording scenario and report the smallest missing capability needed for autonomy.
```

## Outcome

The system can run the core product-specific loop:

```text
semantic code/world signal → target region → embodied navigation/discovery attempt → evidence-backed result
```

## Verification surface

```text
- scenario definition
- scenario runner command
- captured scenario result JSON
- target selection proof from CHANGE_SOURCE verdict/witness
- action trace refs
- frame/screenshot refs
```

## Target selection rules

Use the repo's semantic terminology, but the scenario must not hard-code a specific region name unless configured as a fixture. It should prefer:

```text
1. hot / deviation / highest-urgency verdict region
2. region with witness attached
3. region reachable from current start if reachability data exists
4. otherwise report target selected but reachability unknown
```

## How success is known

```text
- The target is selected from semantic verdict/witness data.
- The scenario emits a result even when navigation fails.
- The result includes enough evidence to diagnose failure.
- The result can be re-run from the same save/spawn where supported.
- Manual-drive mode still records equivalent evidence if autonomy is blocked.
```

## TITAN pressure

Functional correctness. This MVP answers: can the agent perform the declared high-level task, or fail with evidence?

## Stage gate

Run:

```text
- worldspace-qa-runner
- worldspace-adversarial-reviewer
- worldspace-research-checker
- titan-oracle-reviewer
```


---

<!-- Source: goal-cards/04-mvp-4-object-registry-and-nav-probes.md -->

# MVP 4 — Object Registry Adapter and Nav Probes

## Codex goal

```text
/goal Implement MVP 4: add an agent-facing object registry adapter and basic navigation probes over existing world model/render/collision surfaces, verified by a command that lists visible object IDs, semantic kind where known, world position where known, screen-space projection where visible, affordances where known, related region/fog/pin/note/CHANGE_SOURCE metadata where applicable, and front/left/right/back clearance plus floor/grounded and nearest-obstacle telemetry where safely resolvable, while preserving the underlying world model and movement systems. Do not rewrite object ownership or invent affordances that are not grounded in repo metadata. Between iterations, map existing object metadata first, then add projections, then add raycast/nav probes with confidence. Before completion, run QA and adversarial subagent review. If stable IDs or collision geometry are not reliable, mark them partial and report the gap rather than hiding it.
```

## Outcome

The agent can reason about objects, visible targets, screen positions, approximate clearance, and basic reachability signals.

## Verification surface

```text
- object registry adapter type/API
- command output listing visible objects
- navProbe output in FrameEnvelope
- fixture or captured case showing open vs blocked directions
- explicit confidence/unavailable fields
```

## How success is known

```text
- Visible objects can be projected into screen coordinates or explicitly marked unprojectable.
- Registry IDs are stable across one screenshot/save-load case, or instability is documented.
- Affordances are grounded in existing metadata or marked unknown.
- Nav probes distinguish at least one open path and one obvious obstruction.
- The adapter does not replace the world model.
```

## TITAN pressure

State abstraction and action prioritization. Better object/space abstraction should improve scenario planning and oracle quality.

## Stage gate

Run:

```text
- worldspace-qa-runner
- worldspace-adversarial-reviewer
```


---

<!-- Source: goal-cards/05-mvp-5-rgb-visual-replay-windows.md -->

# MVP 5 — RGB Visual Replay Windows

## Codex goal

```text
/goal Implement MVP 5: add time-bounded RGB replay/evidence windows using existing screenshot/RGB capture and FrameEnvelope/action trace artifacts, verified by a command that captures a window with before/during/after frames, action traces, events/signals, region/fog state, CHANGE_SOURCE verdict/witness refs, pins/notes refs where present, and a resolver that maps every evidence ref to a concrete artifact, while preserving screenshot save/load as a state anchor rather than treating it as the full replay system. Between iterations, store metadata refs first, then frame refs, then retention/cadence controls. Before completion, run QA, adversarial, and visual-validation subagent review. If frame capture cadence or storage cost is high, add configurable cadence/retention rather than dropping required evidence fields.
```

## Outcome

The system can cite what the player actually saw around an action or issue.

## Verification surface

```text
- evidence window schema/type
- capture command producing replay/evidence window artifact
- frame refs resolving to image files or encoded refs
- action/event/frame alignment check
- visual validator notes
```

## How success is known

```text
- A replay window includes before/during/after context.
- RGB frame refs are resolvable.
- Action traces and events align with timestamps.
- A future finding can cite frame, action, event, and semantic witness refs.
- Screenshot save/load remains available as state anchor.
```

## TITAN pressure

Trace memory and reflection. This MVP turns one-off state captures into time-bounded evidence that later oracles and reports can cite.

## Stage gate

Run:

```text
- worldspace-qa-runner
- worldspace-adversarial-reviewer
- worldspace-visual-validator
```


---

<!-- Source: goal-cards/06-mvp-6-render-grounded-diagnostic-vision.md -->

# MVP 6 — Render-Grounded Diagnostic Vision

## Codex goal

```text
/goal Implement MVP 6: add render-grounded same-camera diagnostic vision using the existing Three.js/WebGL2 render pipeline, verified by captured aligned RGB and diagnostic x-ray/depth/object-ID/affordance images or capability-specific subsets, while preserving the existing player-facing render path and avoiding any JSON replotted x-ray. Use MRT/render targets and async readback where supported by the existing renderer; start low-resolution and toggleable for ablation. Between iterations, first prove same-camera alignment with one diagnostic pass, then add channels/attachments only after alignment and provenance are verified. Before completion, run QA, adversarial, visual-validation, research, and TITAN-oracle subagent review. If MRT readback is blocked, stop with the technical reason and a fallback single-pass render-target plan.
```

## Outcome

The agent receives an actual render-grounded spatial lens, not just structured JSON.

## Verification surface

```text
- diagnostic capture module
- captured RGB image
- captured diagnostic image(s)
- alignment/provenance check
- channel toggle for ablation
- capture cadence/performance note
```

## Diagnostic view priorities

Build the thinnest useful subset first:

```text
1. same-camera x-ray/semantic view
2. depth or depth-band view
3. object-ID or object-class view
4. affordance view
```

Exact channel names may match repo concepts. The key requirement is render-grounding.

## How success is known

```text
- RGB and diagnostic views are captured from the same camera pose.
- Diagnostic output comes from live scene rendering, not serializeXray plotting.
- At least one diagnostic channel helps distinguish spatial/semantic categories.
- Diagnostic capture can be toggled off.
- Visual validator can inspect alignment and obvious class/depth errors.
```

## TITAN pressure

High-dimensional state abstraction. This should improve the agent's ability to detect spatial blockers, occlusion, reachability mismatch, and visual/debug disagreement.

## Stage gate

Run:

```text
- worldspace-qa-runner
- worldspace-adversarial-reviewer
- worldspace-visual-validator
- worldspace-research-checker
- titan-oracle-reviewer
```


---

<!-- Source: goal-cards/07-mvp-7-oracle-bank-and-layer-4-report.md -->

# MVP 7 — Oracle Bank and Layer-4 Report

## Codex goal

```text
/goal Implement MVP 7: add an initial conservative oracle bank and Layer-4 agent-only evaluation report, verified by running at least one real or fixture scenario that emits evidence-backed findings for functional completion, coverage/discovery, bug/friction, visual/polish hypothesis, learning/world-change hypothesis, and unknown/not-evaluated categories where applicable, while avoiding calibrated human-fun claims. Oracles must cite FrameEnvelope, action trace, replay window, RGB/diagnostic frame, region/fog, pin/note, and CHANGE_SOURCE verdict/witness refs when used. Between iterations, implement one oracle at a time with positive and negative fixtures or captured examples. Before completion, run QA, adversarial, visual-validation where relevant, research, and TITAN-oracle subagent review. If an oracle cannot be validated, mark it experimental and exclude it from blocker severity.
```

## Outcome

The system can generate grounded agent-only findings about playability, friction, polish, and learning value.

## Initial oracles

```text
- stuck / repeated no-op movement
- changed-region-unreachable
- missing-feedback / action-without-response
- fog/verdict mismatch
- stale pin/note
- camera clipping or visual obstruction where detectable
- object/affordance inconsistency
- RGB/diagnostic disagreement
```

## Verification surface

```text
- oracle implementations or registry
- oracle fixture/captured examples
- Layer-4 report artifact
- finding schema output
- evidence ref resolver proof
```

## How success is known

```text
- Every high-severity finding has resolvable evidence refs.
- Report separates completion, coverage, bug/friction, polish, learning-value, positive signals, and unknowns.
- “Fun” appears only as proxy/hypothesis language.
- At least one positive and one negative/unknown signal can be emitted from a run.
- Research checker rejects unfounded human-calibrated claims.
```

## TITAN pressure

Oracle-backed bug/friction detection plus reflective reports. This MVP turns the system from a recorder into an evaluator.

## Stage gate

Run:

```text
- worldspace-qa-runner
- worldspace-adversarial-reviewer
- worldspace-visual-validator where visual claims exist
- worldspace-research-checker
- titan-oracle-reviewer
```


---

<!-- Source: goal-cards/08-mvp-8-ablation-and-regression-harness.md -->

# MVP 8 — Ablation and Regression Harness

## Codex goal

```text
/goal Implement MVP 8: add an ablation and regression harness that runs comparable scenarios under isolated perception/memory arms, verified by a run matrix for at least two arms initially and designed to support JSON-only serializeXray, RGB-retina, diagnostic/x-ray, RGB+diagnostic+JSON, and memory-enabled screenshot/pins/notes/fog arms, while preserving existing systems and preventing memory contamination in non-memory arms. Between iterations, first prove two-arm comparability on the hot-region scenario, then add arms and metrics. Before completion, run QA, adversarial, visual-validation for image arms, research, and TITAN-oracle subagent review. If a channel cannot be isolated, mark that ablation invalid and explain the contamination.
```

## Outcome

The project can answer whether images, x-ray, JSON, and memory actually help the agent navigate, diagnose, and report useful playability findings.

## Arms

```text
A. JSON-only = serializeXray baseline
B. RGB-retina = player-facing image evidence
C. Diagnostic/x-ray = render-grounded x-ray/depth/ID/affordance subset
D. RGB + diagnostic + JSON
E. Memory-enabled = screenshot save/load + pins + notes + fog
```

## Metrics

```text
- completion / reached / not reached / inconclusive
- time or action count to target
- stuck/no-op counts
- oracle findings produced
- evidence quality and ref resolution
- replay inspectability
- report usefulness proxy
- channel-specific failure modes
```

## How success is known

```text
- Same scenario seed can run under at least two arms.
- JSON-only baseline uses serializeXray without accidental enrichment.
- Memory-enabled arm explicitly uses existing screenshot/pins/notes/fog features.
- Diagnostic arms can toggle x-ray on/off.
- Invalid ablations are marked invalid instead of overclaimed.
```

## TITAN pressure

Component-value validation. This stage measures which perception/memory abstractions improve functional completion, coverage/exploration, and oracle quality.

## Stage gate

Run:

```text
- worldspace-qa-runner
- worldspace-adversarial-reviewer
- worldspace-visual-validator for image arms
- worldspace-research-checker
- titan-oracle-reviewer
```


---

<!-- Source: goal-cards/09-optional-mvp-9-titan-style-campaign-runner.md -->

# Optional MVP 9 — TITAN-Style Holistic Campaign Runner

This is intentionally optional and should come after the MVP 8 ablation harness.

## Codex goal

```text
/goal Implement optional MVP 9: extend the scenario and oracle system into a TITAN-influenced holistic campaign runner, verified by a multi-scenario campaign report that covers functional correctness, coverage/exploration, oracle-backed bug/friction detection, trace-memory evidence, regression comparison, and issue clustering, while preserving the MVP 0–8 adapter spine and avoiding architecture drift. Between iterations, add one scenario family and one coverage view at a time. Before completion, run QA, adversarial, research, visual-validation where relevant, and TITAN-oracle subagent review. If campaign runtime or flakiness is high, prioritize deterministic seeds, artifact retention, and partial-run reporting over broad scenario count.
```

## Outcome

The adapter becomes a longer-running automated playability/testing campaign system.

## Adds

```text
- campaign config
- multi-scenario execution
- coverage map / region coverage summary
- issue clustering
- regression comparison to prior run
- optional long-horizon memory use
```

## How success is known

```text
- Multiple scenarios produce comparable artifacts.
- Report separates task completion, coverage, oracle findings, and regressions.
- Coverage is grounded in regions/objects/events the repo can actually observe.
- Findings remain evidence-backed and replayable.
- The system remains an adapter around the existing world, not a replacement framework.
```

## TITAN pressure

Holistic testing. This is where TITAN influence becomes strongest: a single campaign attempts completion, exploration/coverage, and bug/friction detection together.


---

<!-- Source: oracles/ORACLE_BANK.md -->

# Initial Oracle Bank

The oracle bank is conservative. An oracle emits a candidate finding only when it can cite evidence.

Each oracle should specify:

```text
- Inputs
- Trigger condition
- Evidence refs required
- False-positive notes
- Severity rule
- Positive fixture or captured example
- Negative fixture or captured example
```

## Oracle 1 — Stuck / repeated no-op movement

| Field | Definition |
|---|---|
| Inputs | Action traces, before/after poses, navProbe, replay window |
| Trigger | Repeated movement/approach actions produce low or zero movement delta over a time/action threshold |
| Evidence required | actionTraceRefs, frameEnvelopeRefs, optional navProbe refs, RGB replay if available |
| Severity | medium/high depending on task blocking |
| False positives | Intentional waiting, tight interaction zones, scripted pause |

## Oracle 2 — Changed-region unreachable

| Field | Definition |
|---|---|
| Inputs | Scenario result, CHANGE_SOURCE verdict/witness, action traces, final region/distance |
| Trigger | Keystone hot/deviation region cannot be reached or reacquired within scenario budget |
| Evidence required | scenarioResultRef, witnessRefs, actionTraceRefs, final FrameEnvelope/ref |
| Severity | high/blocker if product core loop is blocked |
| False positives | Target intentionally unreachable, missing nav autonomy, manual-drive blocked |

## Oracle 3 — Missing feedback / action without response

| Field | Definition |
|---|---|
| Inputs | action traces, events, RGB replay, object registry |
| Trigger | Interact/inspect/approach/action has no visible, event, state, or telemetry response when one is expected |
| Evidence required | actionTraceRef, before/after frame refs, event absence note, object/affordance ref if applicable |
| Severity | medium/high depending on repetition and goal relevance |
| False positives | Optional object, disabled affordance, response is audio-only/unobserved |

## Oracle 4 — Fog/verdict mismatch

| Field | Definition |
|---|---|
| Inputs | FOG_STATE, CHANGE_SOURCE region verdicts, FrameEnvelope, RGB/x-ray if available |
| Trigger | Region fog state appears inconsistent with semantic verdict or changed-region state |
| Evidence required | regionVerdictRef, fogStateRef, frame/screenshot ref if visualized |
| Severity | medium/high if it misdirects navigation/discovery |
| False positives | Intentional design override, transition state, stale capture |

## Oracle 5 — Stale pin/note

| Field | Definition |
|---|---|
| Inputs | pins/notes, region/object registry, screenshot/save refs, change-source state |
| Trigger | Pin/note points to missing, moved, or semantically stale region/object after world changes |
| Evidence required | pin/note ref, region/object ref, before/after or current state ref |
| Severity | low/medium; high if it breaks navigation or learning task |
| False positives | Historical note intentionally preserved, unresolved migration state |

## Oracle 6 — Camera clip / visual obstruction

| Field | Definition |
|---|---|
| Inputs | RGB frames, camera pose, object/depth/diagnostic view if available |
| Trigger | Player-facing view is blocked by geometry, clips through surfaces, or loses target clarity during scenario |
| Evidence required | RGB frame refs, timestamp window, optional depth/x-ray confirmation |
| Severity | low/medium/high depending on recurrence and task impact |
| False positives | Intentional close-up/cinematic moment, temporary transition |

## Oracle 7 — Object/affordance inconsistency

| Field | Definition |
|---|---|
| Inputs | object registry, action traces, RGB/diagnostic frames, events |
| Trigger | Object appears interactable/relevant but lacks action response, or registry advertises affordance that fails repeatedly |
| Evidence required | objectRef, actionTraceRefs, before/after frames/events |
| Severity | medium/high depending on goal relevance |
| False positives | Locked state, insufficient proximity, missing affordance metadata |

## Oracle 8 — RGB/diagnostic disagreement

| Field | Definition |
|---|---|
| Inputs | same-camera RGB, x-ray/depth/object-ID/affordance captures, object registry |
| Trigger | Diagnostic view indicates obstacle/target/affordance/depth category that contradicts player-facing view or registry |
| Evidence required | aligned RGB ref, diagnostic ref, camera pose ref, object/region refs |
| Severity | medium/high if it affects navigation/evaluation claims |
| False positives | Diagnostic pass intentionally abstracts or hides category, capture desync |

## Report rule

An oracle output is not a final claim. It becomes a Layer-4 finding only after the report layer attaches evidence refs, severity, confidence, suspected cause, and limitations.


---

<!-- Source: ablations/ABLATION_MATRIX.md -->

# Ablation Matrix

The ablation harness answers whether images, render-grounded diagnostic views, structured JSON, and memory artifacts actually help.

## Arms

| Arm | Name | Channels enabled | Existing/new |
|---|---|---|---|
| A | JSON-only | serializeXray | Existing baseline |
| B | RGB-retina | RGB frames + minimal state | Existing capture wrapped into FrameEnvelope/replay |
| C | Diagnostic/x-ray | render-grounded x-ray/depth/object-ID/affordance subset | New in MVP 6 |
| D | RGB + diagnostic + JSON | RGB, diagnostic, serializeXray, FrameEnvelope | Composite |
| E | Memory-enabled | screenshot save/load, pins, notes, fog, plus selected channels | Existing memory/state features wrapped |

## Isolation rules

```text
- Arm A must not see RGB, x-ray, pins, notes, or screenshot memory beyond what serializeXray already exposes.
- Arm B must not see diagnostic/x-ray channels.
- Arm C must not see RGB polish cues unless explicitly configured as C+RGB.
- Arm E must be labeled memory-enabled and not compared as if equivalent to memory-free arms.
- If a channel cannot be isolated, mark the run invalid.
```

## Metrics

```text
Functional correctness:
- reached / not_reached / inconclusive
- action count
- elapsed time
- final distance or region membership

Coverage/exploration:
- regions discovered
- changed regions reached
- visible affordances resolved
- pins/notes used

Bug/friction oracles:
- stuck/no-op count
- missing-feedback events
- fog/verdict mismatch candidates
- stale-pin/note candidates
- camera/visual obstruction candidates
- object/affordance inconsistency candidates

Evidence quality:
- resolvable evidence refs
- replay inspectability
- visual alignment quality
- witness grounding quality

Report usefulness proxy:
- number of findings with evidence
- number of false/unsupported findings rejected by review
- clarity of suspected cause and suggested fix
```

## First ablation target

Start with two arms:

```text
A. JSON-only = serializeXray
B. RGB-retina = existing RGB capture wrapped into replay windows
```

Then add:

```text
C. Diagnostic/x-ray
D. RGB + diagnostic + JSON
E. Memory-enabled
```

## Success standard

```text
- The same scenario seed/config can run under at least two arms.
- The output artifacts use the same scenarioResult/evidence/finding schemas.
- Results show differences or explicitly say no measurable difference.
- Invalid comparisons are marked invalid.
```


---

<!-- Source: research/RESEARCH_ANCHORS.md -->

# Research Anchors

Use these as constraints and vocabulary, not as architecture to copy blindly.

## Codex Goals

Official guide: https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex#how-to-write-a-goal

Applied rule in this archive:

```text
Every MVP goal must specify outcome, verification surface, constraints/boundaries, iteration policy, and blocked stop condition.
Completion is evidence-based: command output, artifacts, source refs, or blocker report.
```

## Codex Subagents

Official guide: https://developers.openai.com/codex/subagents

Applied rule in this archive:

```text
Use subagents explicitly and narrowly.
Prefer read-heavy code mapping, adversarial review, QA, visual validation, and research consistency checks.
Do not run multiple write-heavy agents on the same files.
```

## Three.js / WebGL render grounding

Three.js WebGLRenderer docs: https://threejs.org/docs/pages/WebGLRenderer.html

Applied rule in this archive:

```text
The diagnostic x-ray must be render-grounded: same camera, live scene/render target/MRT or fallback render pass.
serializeXray is the JSON-only baseline, not the x-ray.
```

## TITAN-style testing influence

TITAN paper: https://arxiv.org/abs/2509.22170

Applied rule in this archive:

```text
Use TITAN as evaluation pressure:
- functional correctness via task/scenario completion
- thoroughness via coverage/exploration
- bug/friction detection via oracles
- trace memory/reflection via replayable evidence
Do not clone TITAN architecture; adapt the testing taxonomy to this Three.js codebase-worldspace.
```

## Player-experience modeling and fun language

Applied rule in this archive:

```text
Layer 4 is agent-only and should produce fun/friction/polish/learning hypotheses from proxies.
It should not claim calibrated human enjoyment before a human-labeled Layer 5.
```

## Juicy feedback / playability proxies

Applied rule in this archive:

```text
For player-facing feedback quality, look for evidence around action-outcome legibility, missing feedback, curiosity/discovery hooks, control clarity, and replay-visible response timing.
More feedback is not automatically better; treat this as a hypothesis dimension, not a universal rule.
```
