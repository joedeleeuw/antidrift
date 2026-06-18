# Policy Registries

Some rules are deterministic. Others need structured repo knowledge. Do not implement domain rules as loose keyword scans without a registry.

## Consumer location

For a consuming repository, put the authority index at the repository root:

```txt
policy/registries/*.yaml
```

This matches the shareable config default:

```js
import { createConfig } from "@joedeleeuw/antidrift/eslint-config";

export default createConfig({
  tsconfigRootDir: import.meta.dirname,
});
```

Repos that cannot use a top-level `policy` directory can pass a different path:

```js
export default createConfig({
  tsconfigRootDir: import.meta.dirname,
  policyDir: ".config/antidrift",
});
```

The package should ship rules, loaders, validation, and starter templates. The consuming repo owns the registry contents. Experimental rules can still be distributed, but they should read consumer-owned authority facts and stay inert or inventory-only when the relevant registry is absent.

Treat the registry as a project authority index, not a dependency allowlist. Broad package scans may discover that a local type matches `@firebase/auth#User`; `ownership.yaml` records that this repo accepts that package export as an owner before future redeclarations block.

## Registry files

```txt
policy/registries/architecture.yaml      layer roots, public entrypoints, forbidden pairs
policy/registries/domain.yaml            canonical roles, statuses, entities, enum owners
policy/registries/gateways.yaml          approved SDK/client packages and wrapper modules
policy/registries/design-system.yaml     allowed tokens and banned raw class patterns
policy/registries/boundaries.yaml        route/action/job boundary functions
policy/registries/dependencies.yaml      approved runtime dependency policy
policy/registries/ownership.yaml         accepted package-type authority facts
policy/registries/mcp.yaml               approved MCP servers and tool scopes
policy/registries/rules.yaml             custom rule status, policy rule reviews, semantic fact kinds, signal, promotion, and next action
```

## Ownership Registry

`ownership.yaml` turns discovered installed-package structural matches into accepted owner facts. Without this registry, package matches remain semantic inventory/proposal facts and do not block.

```yaml
packageTypeOwners:
  firebaseAuthUser:
    package: "@firebase/auth"
    exportName: User
    reason: Firebase Auth User is the canonical auth user contract for this repo.
```

The package name must match the package that TypeScript resolves for the exported type. For reexporting packages, this may be the implementation package such as `@firebase/auth` rather than the import specifier used in source.

## Rule behavior

Registry-backed rules should:

1. Load the relevant registry.
2. Stay inert or inventory-only when an optional registry is missing.
3. Give a precise error with the registry file to update.
4. Require a reason when a local override is allowed.
5. Fail loudly when a registry exists but is malformed.

Domain status and role entries should include `valuesExport` when the owner module exports a literal array. `pnpm policy:check-registries` compares registry values to that export so the registry cannot drift from the canonical domain module.

Rule status entries should include every active `antidrift/*` rule exported by the plugin. Every active non-stable rule must declare one or more active-rule `proofBuckets` so package consumers can query the rule by proof carrier before it is stable; split rules may list multiple buckets when different branches have different proof floors. Semantic adapter buckets such as `semantic-source-type-provenance`, `authority-index-ownership`, and `graph-config-source` are claimed by shipped adapters or by `semanticAdapterStatus.status: inline-pending` while the proof still lives inside a rule. Command-owned buckets such as `diff-relative` are claimed by command/fact registry rows instead; they are invalid for active plugin-rule rows and semantic adapter contracts, do not imply a shipped semantic adapter, and must not be treated as an adapter fallback. Stable semantic-adapter proof still requires a shipped semantic adapter claim. Every active rule must name a repo-local `referenceDoc` that records the rule's current investigation state, ecosystem comparison, evidence, and blockers. Research candidates can use command-owned proof buckets only when the candidate ID is backed by a command-owned semantic fact such as `antidrift/change-contract-conformance`; candidates with sufficient online/ecosystem coverage should be marked `ecosystem-covered` instead of becoming custom rules.

Stable active rules must include a `promotion` block and enough `corpusRepositories` entries to satisfy `promotionRequirements.stable.minIndependentRepositories`. The promotion block is the machine-checked promotion contract: proof bucket, semantic association or authority fact, blocking threshold, ecosystem comparison, corpus evidence, real-corpus inventory pointer, Claude advisory review pointer, non-test-created replication assertion, known false-positive and false-negative counts, production-concern state, no-sink behavior, and no-dead-work behavior. `realCorpusInventoryRefs` and `claudeAdvisoryReviewRefs` must be non-empty arrays of repo-relative paths that exist, so stable promotion cannot rely on stale prose. Ready or under-proven rules can omit the block until they meet the stable bar.

Semantic fact kinds belong in `policy/registries/rules.yaml` under `semanticFactKinds`. Each emitted fact kind must name its owning active rule or command IDs, adapter ID, proof carrier, confidence level, emission mode, semantic association, no-sink behavior, and payload fields. Command-owned facts use `rules: []` plus non-empty `commandIds` so they stay out of the active ESLint rule surface while remaining first-class policy facts. `pnpm policy:check-registries` compares this registry to the fact kinds emitted by the plugin and change-scope commands and to the shipped `SEMANTIC_FACT_KINDS` export from `@joedeleeuw/antidrift/policy`, so semantic adapters and command-owned facts become public package contracts instead of private internals. The ESLint plugin tests exercise emitted rule facts against the registered `payloadFields`, `adapterId`, rule IDs, and confidence values so payload drift breaks package verification.

Policy rule reviews should include every rule ID named in `policy/agent-guardrails.yaml`, whether that ID is implemented as an active custom rule, covered by a maintained ecosystem rule, generated as core ESLint config, enforced by hooks or policy scripts, delegated to Sonar, merged into another rule, research-only, or spec-only. This keeps broad policy scope from being mistaken for active implementation scope.

`pnpm policy:check-registries` fails when an active rule is missing from `policy/registries/rules.yaml`, when a retired rule is placed in the active table, when a locked retired/ecosystem-covered decision is removed or reactivated, when a policy-scoped rule lacks a review row, when a review row names a rule outside the policy source, or when investigation/stable-promotion gates are weakened.
