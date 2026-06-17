<!-- Authored by codex gpt-5.5/xhigh against the repo (solve-buckets, semantic-facts, cli, check-registries, git plumbing) + the additional-approaches discussion. The implementation target for the change-contract spine. v0 inventory, TS export extraction, diff-scoped adapter inventory, and module graph radius inventory are implemented; enforcement remains gated on real evidence. -->

**SPEC: Change-Contract Conformance Spine**
Grounding: this is the deterministic core already described in [additional-approaches-discussion.md](/Users/sushi/code/agent-guardrails-monorepo-template/docs/research/additional-approaches-discussion.md:9): prove “the diff exceeded the declared scope contract,” not intent. It belongs in the missing change-relative seam called out in [solve-bucket-architecture-review.md](/Users/sushi/code/agent-guardrails-monorepo-template/docs/solve-bucket-architecture-review.md:29), targets the n=60 `diff-scope-creep` gap in [solve-buckets.yaml](/Users/sushi/code/agent-guardrails-monorepo-template/policy/registries/solve-buckets.yaml:97), and must emit the existing `semanticFact` shape from [semantic-facts.mjs](/Users/sushi/code/agent-guardrails-monorepo-template/tooling/antidrift/src/policy/lib/semantic-facts.mjs:189).

**1. Change Contract Artifact**
Default path: `.antidrift/change-contract.yaml`. CLI must also accept `--contract <path>` and `ANTIDRIFT_CHANGE_CONTRACT`. YAML is preferred, JSON accepted by extension. Missing contract is not a failure in v0: emit/report `contractState: "missing"` inventory and exit 0. Invalid contract is always loud failure, no silent defaults.

Authoring: human-owned. An agent may draft it only as an echo-back artifact, but proof treats it as deterministic input only after human acceptance. For future blocking, the contract must be immutable relative to the change: either present unchanged at merge-base, or supplied by CI as an external artifact with a pinned hash. If the contract is new or modified inside the same diff, v0 records `contractState: "new-in-diff"` or `"modified-in-diff"` and never blocks.

Schema, all arrays explicit:

```yaml
schemaVersion: 1
contractId: "TASK-123"
task:
  title: "Fix order total display"
  source: "jira:SHOP-123"
authorship:
  kind: "human" # human | agent-draft-human-accepted
  approvedBy: "sushi"
scope:
  allowedPaths: ["apps/shop/src/orders/**"]
  forbiddenPaths: ["apps/shop/src/billing/**"]
  allowedChangeTypes: ["modify"] # add | modify | delete | rename
  allowedExports:
    - file: "apps/shop/src/orders/format.ts"
      name: "formatOrderTotal"
      kind: "value" # value | type | default | namespace
  allowedRuntimeDependencies: []
  allowedDevDependencies: []
  allowedEntrypoints: ["apps/shop/src/orders/page.tsx"]
  maxTouchedModuleRadius: 1
  allowedOwnerSymbols: []
refactor:
  approved: false
  justification: ""
```

Validation: implemented as a local structural validator in `tooling/antidrift/src/change-scope/contract-schema.mjs` because this runs in the shipped CLI and should not add a new runtime dependency for a small fixed schema. Reject unknown top-level keys, empty `contractId`, non-relative paths, absolute paths, `..`, empty glob arrays, broad `**/*` unless `refactor.approved: true`, missing `scope`, and any `allowedExports` entry without exact `file`, `name`, and `kind`.

**2. Change Surface**
Add merge-base plumbing beside existing [git.mjs](/Users/sushi/code/agent-guardrails-monorepo-template/tooling/antidrift/src/policy/lib/git.mjs:10), preserving `changedFiles()` for `check-changed`. New helpers:
`mergeBase(baseRef, headRef)`, `changedFilesBetween({ base, head, includeStatus: true })`, `gitShow(ref, path)`, `diffHunksBetween({ base, head })`.

Base resolution: `--base <ref>` or `ANTIDRIFT_BASE_REF` is required when a contract exists. `--head` defaults to `HEAD`. Compute `mergeBase = git merge-base baseRef headRef`, then diff `mergeBase` to `headRef`.

Collect these deterministic surfaces:

- `changedFiles`: from `git diff --name-status --find-renames --diff-filter=ACDMRTUXB <mergeBase> <head>`. Include `path`, `oldPath`, and `status`.
- `patchHunks`: from `git diff --unified=0 <mergeBase> <head>`, only for Phase-0 diff-scoped adapter filtering.
- `addedExports` and `removedExports`: build a TS Program for HEAD and a TS Program for merge-base. Use a temp materialized base tree or a CompilerHost over `git show`; do not parse regex. For each changed TS source, each declaration file, and each unchanged TS file that re-exports a changed TS source through relative export declarations, use `checker.getSymbolAtLocation(sourceFile)` plus `checker.getExportsOfModule(moduleSymbol)`, following the existing TypeChecker/export pattern in [type-index.mjs](/Users/sushi/code/agent-guardrails-monorepo-template/tooling/antidrift/src/policy/lib/type-index.mjs:97). Compare exact `{file, name, kind}` sets. The ref-backed CompilerHost must resolve relative TS source re-exports (`export { x } from`, `export type { T } from`, `export * from`, `export * as ns from`) from the git tree, including ESM `.js` specifiers that point at TS sources. If a public re-export module cannot be resolved, fail loudly instead of silently dropping exports. For deleted files, all baseline exports are removed; for added files, all HEAD exports are added. File path is part of the public surface identity: a rename records removed exports at the old path and added exports at the new path.
- `addedDependencies`: parse changed `package.json` files at base and head. Runtime dependency buckets are `dependencies`, `optionalDependencies`, and `peerDependencies`; `devDependencies` is separate. Added means package key absent at base and present at head, or moved from dev to runtime. Lockfile-only changes are inventory-only in v0.
- `touchedModuleGraph`: build from HEAD TS Program using static `import`, `export ... from`, and string-literal dynamic `import()`. Compute undirected shortest-path distance from `scope.allowedEntrypoints` to each touched TS file. This is v1 inventory first, not v0 blocking.

**3. Conformance Checks**
v0 deterministic violation types:

- `forbidden-path-touched`: any changed `path` or `oldPath` matches `scope.forbiddenPaths`.
- `path-out-of-scope`: any changed `path` or `oldPath` fails all `scope.allowedPaths`.
- `undeclared-change-type`: git status maps to an operation not in `scope.allowedChangeTypes`.
- `undeclared-added-export`: an added export is not exactly listed in `scope.allowedExports`. `file`, `name`, and `kind` must all match; omitted `kind` is invalid schema, not a wildcard.
- `undeclared-runtime-dependency`: added runtime dependency not listed in `scope.allowedRuntimeDependencies`.
- `undeclared-dev-dependency`: added dev dependency not listed in `scope.allowedDevDependencies`, inventory-only by default.

Later phases: `module-radius-exceeded`, `undeclared-owner-symbol`, `public-route-surface-expanded`, `schema-service-owner-added`, `dependency-version-scope-expanded`, and refactoring-aware move/extract classification. Do not implement those as line-count or churn thresholds.

**4. Semantic Fact**
Add `changeContractConformance` to `SEMANTIC_FACT_KINDS` in [semantic-facts.mjs](/Users/sushi/code/agent-guardrails-monorepo-template/tooling/antidrift/src/policy/lib/semantic-facts.mjs:6):

```js
changeContractConformance: Object.freeze({
  rules: Object.freeze([]),
  commandIds: Object.freeze(["antidrift/change-contract"]),
  adapterId: "change-contract",
  carrier: "change-relative",
  confidence: Object.freeze(["deterministic-inventory"]),
  emission: Object.freeze(["inventory-only"]),
  association: "Merge-base diff surface to a machine-readable change contract.",
  noSinkBehavior:
    "The CLI still prints the conformance summary; only serialized semantic fact output is skipped.",
  payloadFields: Object.freeze([
    "contractState",
    "changeContext",
    "declaredScope",
    "actualChangeSurface",
    "violations",
    "decision",
  ]),
});
```

Fact emission uses `semanticFact({ ruleId: "antidrift/change-contract-conformance", adapterId: "change-contract", confidence: "deterministic-inventory", provenance: ["git-diff", "change-contract", "ts-program", "package-manifest"], filePath: contractPath, payload })`.

Registry ripple:

- Add `carrier: change-relative` to checker allowed carriers, currently limited in [check-registries.mjs](/Users/sushi/code/agent-guardrails-monorepo-template/tooling/antidrift/src/policy/check-registries.mjs:588), and to `SemanticFactCarrier` in [index.d.mts](/Users/sushi/code/agent-guardrails-monorepo-template/tooling/antidrift/src/policy/index.d.mts:39).
- Add provenance literals to [index.d.mts](/Users/sushi/code/agent-guardrails-monorepo-template/tooling/antidrift/src/policy/index.d.mts:53).
- Mirror the fact in `policy/registries/rules.yaml` under `semanticFactKinds`, matching the shipped contract exactly as required by [check-registries.mjs](/Users/sushi/code/agent-guardrails-monorepo-template/tooling/antidrift/src/policy/check-registries.mjs:1227).
- Extend `checkSemanticFactKindEntry` so `rules: []` is valid only when `commandIds` is non-empty. Existing validation assumes active ESLint rules at [check-registries.mjs](/Users/sushi/code/agent-guardrails-monorepo-template/tooling/antidrift/src/policy/check-registries.mjs:1245), which would reject this command-owned fact.
- Extend emitted-kind discovery beyond the ESLint plugin source, currently regex-scoped to one file at [check-registries.mjs](/Users/sushi/code/agent-guardrails-monorepo-template/tooling/antidrift/src/policy/check-registries.mjs:1026). Scan production `src/policy` and `src/change-scope`, excluding tests and fixtures.
- Add `diff-relative` to proof-bucket types/checker if any registry entry references this spine; current allowed buckets stop at `repo-session-runtime` in [check-registries.mjs](/Users/sushi/code/agent-guardrails-monorepo-template/tooling/antidrift/src/policy/check-registries.mjs:607).

**5. Architecture Integration**
Module layout:

- `tooling/antidrift/src/change-scope/contract-schema.mjs`
- `tooling/antidrift/src/change-scope/change-context.mjs`
- `tooling/antidrift/src/change-scope/surface.mjs`
- `tooling/antidrift/src/change-scope/exports.mjs`
- `tooling/antidrift/src/change-scope/dependencies.mjs`
- `tooling/antidrift/src/change-scope/module-graph.mjs`
- `tooling/antidrift/src/change-scope/analyze.mjs`
- `tooling/antidrift/src/policy/change-contract.mjs`

The existing untracked `tooling/antidrift/src/change-scope/analyze.mjs` is the right rough pure-core direction, but first PR should tighten schema, contract states, exact violation names, and no-comment style.

CLI: add `parseArgs as parseChangeContractArgs` and `changeContractConformance` import to [cli.mjs](/Users/sushi/code/agent-guardrails-monorepo-template/tooling/antidrift/src/policy/cli.mjs:1), then add command `"change-contract"` in the command map near existing inventory commands at [cli.mjs](/Users/sushi/code/agent-guardrails-monorepo-template/tooling/antidrift/src/policy/cli.mjs:172). Options: `--contract`, `--base`, `--head`, `--tsconfig`, `--facts-out`, `--output`, `--mode inventory|enforce`, `--require-contract`.

Verify-session: add root script `policy:inventory-change-contract` and include it in [verify-session.mjs](/Users/sushi/code/agent-guardrails-monorepo-template/tooling/antidrift/src/policy/verify-session.mjs:6) after registry checks. It exits 0 when no contract exists; if a contract exists, invalid schema or missing base fails. Keep v0 violations non-blocking. `policy:verify-session` is already the full gate via [package.json](/Users/sushi/code/agent-guardrails-monorepo-template/package.json:39).

Phase-0 precursor: `diff-scoped-adapters` inventory uses the same change context. It runs ESLint only on changed JS/TS files like [check-changed.mjs](/Users/sushi/code/agent-guardrails-monorepo-template/tooling/antidrift/src/policy/check-changed.mjs:7), captures messages and semantic facts, filters to changed hunks, and writes inventory. This is not the conformance proof; it validates the merge-base/hunk plumbing and reuses existing adapters as recommended in [solve-bucket-architecture-review.md](/Users/sushi/code/agent-guardrails-monorepo-template/docs/solve-bucket-architecture-review.md:106).

**6. FP Controls And Maturity**
No contract, new-in-diff contract, modified-in-diff contract, or broad refactor contract can produce blocking output in v0. Broad refactors require `refactor.approved: true`, non-empty `justification`, and explicit broad paths. Generated files are not silently ignored; they must be in `allowedPaths` or derived from accepted generated registry facts in a later phase.

Evidence plan: mine the n=60 complaint corpus from [reports/complaint-sweep-2026-06-10.json](/Users/sushi/code/agent-guardrails-monorepo-template/reports/complaint-sweep-2026-06-10.json:269). Build a report with true drift, clean narrow fixes, broad refactors, generated churn, dependency-only changes, and no-contract controls across at least two independent repos. Promotion must follow existing stable requirements: at least two repos, no known FPs/FNs, real corpus inventory, and advisory review as specified in [rules.yaml](/Users/sushi/code/agent-guardrails-monorepo-template/policy/registries/rules.yaml:12).

**7. Deterministic And LLM Boundary**
LLM may draft or critique the contract. LLM may not decide conformance, widen scope at proof time, infer unstated intent, or produce blocking output. The proof inputs are only merge-base tree, HEAD tree, package manifests, TS Program facts, module graph, and the validated contract. The claim string in output must be exactly: `the diff exceeded the declared scope contract`.

**8. First-PR Build Order**

1. Land `change-context` git helpers and tests with a temp git repo.
2. Land contract schema/parser and pure `analyzeChangeScope()` tests for path, operation, dependency, and export violation semantics.
3. Land v0 surface extraction for changed files and package dependencies.
4. Add `changeContractConformance` fact contract plus registry-check support for command-owned facts.
5. Add `antidrift change-contract` CLI with JSON summary and optional JSONL facts.
6. Add `policy:inventory-change-contract` to verify-session, non-blocking on no-contract and violations.
7. Land TS Program before/after export extraction.
8. Land diff-scoped existing-adapter inventory.
9. Land module graph radius inventory.
10. Only after multi-repo evidence: add `deterministic-enforcement` and `blocking-diagnostic` to the fact contract, plus `--mode enforce`.
