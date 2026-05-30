# Custom Rule Authoring Guide

## Rule categories

### Deterministic rules

These do not need project-specific vocabulary:

- trivial selector wrappers
- explicit private helper return types
- unsafe cast chains
- silent catches
- coupled state setters
- `data/loading/error` status triplets
- `.only` and skipped tests
- inline disables without a reason

### Registry-backed rules

These need repo facts:

- domain statuses and roles
- canonical model names
- approved gateway imports
- architecture layer paths
- server boundary functions
- design tokens
- MCP servers and tool permissions

### Review-first heuristics

These should start as warnings:

- feature scatter
- model similarity
- one-use helpers
- generic AI copy
- high-fan-in file growth

## Rule implementation guidance

- Keep each rule narrow and explain the desired replacement in the message.
- Prefer syntax-only checks for fast feedback.
- Move type-aware checks into ESLint via `typescript-eslint` parser services when needed.
- Emit machine-readable reports for Sonar import.
- Do not rely on prompt instructions for a rule that can be enforced mechanically.

## Naming convention

```txt
antidrift/<cluster>-<specific-smell>
```

Examples:

```txt
antidrift/no-trivial-selector-wrapper
antidrift/no-coupled-state-setters
antidrift/no-status-triplet-state
antidrift/no-silent-catch
antidrift/no-raw-tailwind-color
```
