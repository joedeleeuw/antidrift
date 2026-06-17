# Declaration Clone Inventory

Status: research inventory-only.
Command: `pnpm policy:inventory-declaration-clone-source-fleet`.
Current evidence file: `reports/declaration-clone-source-fleet-inventory.json`.

## Scope

This inventory searches for duplicate TypeScript object contract declarations before we decide whether a blocking rule exists. It uses the TypeScript checker to fingerprint interface declarations and literal object type aliases by declared member name, type, optionality, and readonly state. It ignores pure aliases and inherited-only interfaces so reuse such as `type Local = Owner` or `interface Local extends Owner {}` does not inflate fork evidence.

The output is deliberately non-blocking. It separates generated-only, mixed generated/source, and source-only clone groups so promotion work can start from likely owner-fork evidence without discarding generated-authority pressure.

## Current Source-Fleet Result

The June 17, 2026 source-fleet run checked four local real-code repositories:

- `chaski`
- `codebase-atlas`
- `sudocode-main`
- `opencode`

The run checked 1,349 files, inspected 1,403 object declarations, found 51 clone groups, and had 0 parser errors.

Clone group split:

| Bucket                 | Groups | Meaning                                                                                                                                                                         |
| ---------------------- | -----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source-only            |     34 | Hand-authored declarations share the same declared-member shape. These are the first promotion candidates, but may still be legitimate UI prop or request/response duplication. |
| Mixed generated/source |      4 | Hand-authored declarations match generated declarations. These are strongest owner-authority candidates if the generated source is accepted as the owner.                       |
| Generated-only         |     13 | Generated declarations duplicate each other. These are corpus noise for lint enforcement unless another source declaration forks them.                                          |

## Example Findings

Source-only examples:

| Repo            | Declarations                                                                                                        | Interpretation                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `sudocode-main` | `frontend/src/lib/api.ts:667` `BatchImportResponse`; `server/src/routes/import.ts:169` `BatchImportResponse`        | Likely frontend/server contract duplication. Needs owner direction before enforcement. |
| `sudocode-main` | `frontend/src/lib/api.ts:628` `ImportSearchRequest`; `server/src/routes/import.ts:105` `ImportSearchRequest`        | Likely request contract duplication across boundary.                                   |
| `sudocode-main` | `frontend/src/types/api.ts:27` `RepositoryInfo`; `server/src/services/repo-info.ts:8` `RepositoryInfo`              | Likely shared API model fork.                                                          |
| `chaski`        | Five `OrdersOpsV2` dialog prop interfaces with the same `open`, `onClose`, `onSuccess`, `order`, and `orders` shape | More likely UI prop repetition than owner drift; useful false-positive pressure.       |

Mixed generated/source examples:

| Repo     | Declarations                                                                                                                                                                                                                                                                                                                    | Interpretation                         |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `chaski` | Generated `ServiceWindow` at `src/frontend/bff/gen/ts/src/idls/protos/monolith/scenarios/v1/scenarios.ts:815`; source `RawSvcWindow` at `src/frontend/monolithui/src/components/CrowOps/ui/AccountServiceStopsModal.tsx:33`; source `SvcWindow` at `src/frontend/monolithui/src/components/CrowOps/ui/DeliveryEventModal.tsx:7` | Strong generated-owner fork candidate. |
| `chaski` | Generated `RouteStop` at `src/frontend/bff/gen/ts/src/idls/protos/monolith/scenarios/v1/scenarios.ts:1845`; source `RouteStop` at `src/frontend/monolithui/src/components/CrowOps/types.ts:45`                                                                                                                                  | Strong generated-owner fork candidate. |
| `chaski` | Generated `AccountCluster` at `src/frontend/bff/gen/ts/src/idls/protos/monolith/scenarios/v1/scenarios.ts:1828`; source `AccountCluster` at `src/frontend/monolithui/src/components/CrowOps/types.ts:30`                                                                                                                        | Strong generated-owner fork candidate. |
| `chaski` | Generated `VisibleAgent` at `src/frontend/bff/gen/ts/src/idls/protos/monolith/scenarios/v1/scenarios.ts:1836`; source `VisibleAgent` at `src/frontend/monolithui/src/components/CrowOps/types.ts:37`                                                                                                                            | Strong generated-owner fork candidate. |

Generated-only examples:

- Chaski generated protobuf `MessageFns` appears 76 times with the same helper method surface.
- Chaski generated QR action request/response shapes duplicate across `counts` and `qractions` protobuf outputs.

Generated-only groups are useful for understanding source pressure but must not count as promotion drift by themselves.

## Promotion Requirements

A declaration-clone lint rule is not promoted from this inventory alone. Promotion needs all of the following:

- At least two independent repositories with accepted remediated source or mixed generated/source owner-fork cases.
- Clean controls for repeated UI prop shapes, form/draft models, view-model projections, and intentionally mirrored API request/response contracts.
- A deterministic owner authority rule: generated owner, domain owner, accepted package owner, or explicit shared contract owner. Exact shape alone is inventory, not proof.
- A blocking threshold that ignores generated-only groups and only reports when the local declaration is a fork of an accepted owner.
- Ecosystem comparison showing why maintained TypeScript ESLint/import tooling does not already cover the owner-fork behavior.
- No-sink/no-dead-work behavior: without a fact sink, inventory collection may be dropped, but any future blocking rule must still report accepted-owner diagnostics through ESLint.

## Current Decision

Keep `inventory/declaration-clone` as research inventory. The source-fleet scan proves useful real-code pressure and identifies likely generated-owner forks, but it does not yet prove enough accepted-owner authority or clean-control boundaries for enforcement.
