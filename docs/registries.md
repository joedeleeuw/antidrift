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

The package ships rules, loaders, validation, and starter templates. The consuming repo owns the registry contents. Rules that need consumer-owned authority facts act only when those facts are supplied; missing optional facts do not manufacture findings, and malformed registries fail loudly.

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
policy/registries/rules.yaml             semantic fact contracts and published rule retirements
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

`retiredRules` records published rule IDs that have been removed, why they were removed, and any replacement owner. It prevents identifier reuse without keeping compatibility implementations.

Semantic fact kinds belong in `policy/registries/rules.yaml` under `semanticFactKinds`. Each emitted fact kind must name its owning active rule or command IDs, adapter ID, proof carrier, confidence level, emission mode, semantic association, no-sink behavior, and payload fields. Command-owned facts use `rules: []` plus non-empty `commandIds` so they stay out of the active lint-rule surface while remaining first-class policy facts. `pnpm policy:check-registries` compares this registry to the fact kinds emitted by the plugins and change-scope commands and to the shipped `SEMANTIC_FACT_KINDS` export from `@joedeleeuw/antidrift/policy`, so semantic adapters and command-owned facts become public package contracts instead of private internals. Behavioral plugin tests exercise emitted rule facts against the registered `payloadFields`, `adapterId`, rule IDs, and confidence values so payload drift breaks package verification.

`pnpm policy:check-registries` validates functional consumer registries, semantic-fact contracts, and retirement records. `pnpm policy:check-rule-surface` independently checks plugin export/config membership and rejects duplicate runtime owners. Behavioral tests and packed-consumer execution provide evidence; there is no per-rule maturity, promotion, research, or policy-review registry.
