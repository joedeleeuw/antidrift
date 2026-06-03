# Domain Canonical Model Fork Investigation

## Candidate

Detect local redeclarations of repo-owned domain models that should import or derive from `packages/domain` or another configured canonical domain owner.

## Ecosystem Check

General TypeScript and ESLint rules cannot know repository domain ownership. Existing domain literal rules cover status and role unions, but not whole model forks.

## Potential Custom Solve

Use TypeChecker plus `policy/registries/domain.yaml`:

1. Resolve configured canonical domain entities.
2. Compare local object type/interface declarations against the canonical model shape.
3. Allow aliases, imports, utility-type derivations, and explicitly sanctioned boundary DTOs.
4. Report local structural copies that should import or derive from the canonical owner.

## Known Risks

- Domain models, DTOs, view models, and wire contracts can legitimately overlap.
- Small models produce high false-positive risk.
- The rule needs allowlists before it can be an error.

## Entry Conditions

- A real repository contains a domain model fork.
- A real repository contains clean DTO/view-model controls.
- Registry allowlists for sanctioned forks are defined before enforcement.
- Claude Opus 4.8 review has read the registry, candidate implementation, and corpus evidence.
