# Feature Slice Template

Use this before adding a new feature, domain concept, integration, or generated source. It is intentionally short: the point is to choose the owner once, then make every layer import or translate from that owner.

## Slice

- Feature:
- User-facing behavior:
- Owning module:
- Existing concept/type/schema to import:
- New concept/type/schema required:

## Concept Ownership

- Domain owner file:
- Contract/schema owner file:
- API boundary file:
- Gateway owner file, if an external SDK is involved:
- UI resource/reducer owner file:

## Registries

- `policy/registries/domain.yaml` update:
- `policy/registries/gateways.yaml` update:
- `policy/registries/generated.yaml` update:
- `policy/registries/boundaries.yaml` update:

## Enforcement

- Rule that should fail if the slice is duplicated:
- Real corpus assertion to add or update:
- Policy script check to add or update:
- Docs coverage status to update:

## Validation

Run:

```bash
pnpm policy:check-registries
pnpm policy:check-rule-surface
pnpm policy:verify-session
```

Stop if the answer to "which module owns this concept?" is unclear.
