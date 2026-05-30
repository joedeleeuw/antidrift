# Policy Registries

Some rules are deterministic. Others need structured repo knowledge. Do not implement domain rules as loose keyword scans without a registry.

## Registry files

```txt
policy/registries/architecture.yaml      layer roots, public entrypoints, forbidden pairs
policy/registries/domain.yaml            canonical roles, statuses, entities, enum owners
policy/registries/gateways.yaml          approved SDK/client packages and wrapper modules
policy/registries/design-system.yaml     allowed tokens and banned raw class patterns
policy/registries/boundaries.yaml        route/action/job boundary functions
policy/registries/dependencies.yaml      approved runtime dependency policy
policy/registries/mcp.yaml               approved MCP servers and tool scopes
```

## Rule behavior

Registry-backed rules should:

1. Load the relevant registry.
2. Fail closed when the registry is missing or malformed.
3. Give a precise error with the registry file to update.
4. Require a reason when a local override is allowed.
