# antidrift

A focused Oxlint governance config, a native Rust `tsrslint` type-aware rule engine (`antidrift-linter`), and a policy generator. It exists to catch the specific ways a codebase rots when an agent is the one writing it.

Regular linters check syntax and a handful of correctness rules. They don't notice when an agent redeclares a type that already ships with `firebase`, wires up a `useEffect` with no dependency array, or quietly swallows an error to turn a red test green. Those edits compile. They pass review when the reviewer is skimming. Then they drift. You end up with three slightly different `User` types, four copies of the same fetch logic, and a component that re-renders on every keystroke.

antidrift writes those patterns down as deterministic rules so the machine catches them instead of you.

All 83 `antidrift/*` rules run in a single native Rust engine (`antidrift-linter`, built on `tsrs_ast`, `tsrs_compiler`, `tsrs_checker`, and `tsrslint`) invoked through `antidrift oxlint`. Generic TypeScript and maintained third-party rules belong to `@joedeleeuw/typescript-tooling`; consumers choose their broader React, Vitest, import-style, and repository-boundary baselines.

Antidrift's custom rules concentrate on contract ownership, boundary decoding, independent test oracles, resource lifecycles, and framework-specific proof. React, Convex, Effect, TanStack, and Bun integrations are not repository-specific. Naming, comment, layout, token, and architecture conventions are consumer policy; configure their scopes rather than treating them as universal correctness.

The positive pattern behind the rules is one owner per concept: domain owns business vocabulary, contracts own wire schemas, API boundaries validate and authorize, gateways own SDKs, and UI consumes resource/result unions instead of local duplicate shapes.

## Install

```sh
pnpm add -D @joedeleeuw/antidrift typescript
```

## Default Ruleset

`antidrift/no-wrapping-functions` runs as a typed rule in `antidrift-linter` that inlines each candidate in memory and reports only verified hops. Named functions and named arrows that only delegate to another call, read a parameter property, or apply a literal property fallback must earn their extra layer through a concrete boundary or callback requirement. Exports are included. Anonymous inline callbacks, calculations, argument transformations and functions that own additional behavior stay outside the rule. It provides no automatic fix. When removing a callback adapter, preserve its exact signature, receiver behavior, hook position and stable identity; pass the existing owner directly only when it already satisfies that callback contract.

The default `antidrift-linter` ruleset also enforces shared AGENT.md directives recorded in `policy/agent-guardrails.yaml`: `antidrift/no-anemic-errors` (G7), `antidrift/no-dated-comments` (S5), `antidrift/no-host-path-literal` (S4), `antidrift/no-pass-through-parameters` (G22), and `antidrift/no-compat-names` (G5) (`antidrift/no-vague-names` for G21 remains registered for explicit opt-in). G8 maps to native `no-nested-ternary`, owned by `@joedeleeuw/typescript-tooling`. G9 maps to `unicorn-js/prefer-switch` there.

Size caps come from one kernel table shared with the Rust self-lint. `antidrift/max-module-lines` warns above 1,200 lines and errors above 1,500, `antidrift/max-function-lines` warns above 40 and errors above 50, and `antidrift/max-component-lines` warns above 150 and errors above 180 for PascalCase functions that render JSX. Blank and comment lines count. Describe-style suite callbacks are containers, so they are exempt; `it` and `test` bodies are not. Generated-looking file names get no exemption; declare codegen output in `policy/registries/generated.yaml` to exclude it. If your base config enables Oxlint `max-lines` or `max-lines-per-function`, turn them off so each size has one owner. Oxlint reports every antidrift diagnostic at error, so under Oxlint the warn tier blocks too.

The default ruleset also enforces these rules at error:

- G15 test independence: `antidrift/no-nonindependent-test-oracle`
- W4 type reuse: `antidrift/no-redeclared-owned-union`
- G4 boundary decoding: `antidrift/unknown-input-must-be-decoded`
- G7 loud failure: `antidrift/no-sentinel-absence-fallback`
- React and markup hygiene: `antidrift/no-calling-components-as-functions`, `antidrift/no-duplicated-conditional-classnames`
- Type-checked authority & boundary rules: `antidrift/no-structural-type-fork`, `antidrift/no-contract-appeasement-projection`, `antidrift/no-redundant-zod-parse`, `antidrift/no-identity-schema-transform`, `antidrift/require-convex-return-validator`, `antidrift/no-explicit-type-arguments-on-owned-api`, `antidrift/no-schema-validator-transcoding`, `antidrift/no-redundant-type-predicate`, `antidrift/no-underchecked-type-predicate`, `antidrift/no-unresolved-dependency-types`, `antidrift/no-service-constructor-imports`, and `antidrift/no-sql-string-concat`.

## Quickstart (Standalone)

Create `oxlint.config.mjs`:

```js
import { createGovernanceOxlintConfig } from "@joedeleeuw/antidrift/oxlint-config";

export default createGovernanceOxlintConfig({
  repoRoot: import.meta.dirname,
});
```

Run the unified Oxlint + native Rust `antidrift-linter` gate:

```sh
npx antidrift oxlint
```

## Composing with `@joedeleeuw/typescript-tooling` or Custom Oxlint Configs

```ts
import { createGovernanceOxlintConfig } from "@joedeleeuw/antidrift/oxlint-config";
import { createConfig } from "@joedeleeuw/typescript-tooling/oxlint";

const governance = createGovernanceOxlintConfig({
  repoRoot: import.meta.dirname,
});
const tooling = createConfig({ repoRoot: import.meta.dirname });

export default {
  ...tooling,
  rules: { ...tooling.rules, ...governance.rules, "max-lines": "off" },
  ignorePatterns: [
    ...new Set([...governance.ignorePatterns, ...tooling.ignorePatterns]),
  ],
  overrides: [...(tooling.overrides ?? []), ...governance.overrides],
};
```

The governance config sets only antidrift's import restrictions, ignore patterns and overrides. Categories, plugins, `denyWarnings` and unused-directive reporting stay with your config. Oxlint cannot see antidrift's rules, so if your config reports unused disable directives, a disable comment naming an antidrift rule is reported as unused even though antidrift honored it.

Generate policy artifacts when `policy/agent-guardrails.yaml` changes:

```sh
npx antidrift generate
```

If you use the generated hooks/instructions, add the scripts they call to your root package:

```json
{
  "scripts": {
    "policy:generate": "antidrift generate",
    "policy:check-generated": "antidrift check-generated",
    "guardrails:shell": "antidrift shell",
    "policy:check:changed": "antidrift check-changed",
    "policy:verify-session": "antidrift verify-session"
  }
}
```

## What's in the box

Public entry points, one package:

- `@joedeleeuw/antidrift` — package primitives: `createGovernanceOxlintConfig`, policy rendering, and registry loading
- `@joedeleeuw/antidrift/package.json` — package metadata for consumer tooling
- `@joedeleeuw/antidrift/brand` — `Brand<T, Name>`, `Unbrand<T>`, and `brand(name, check)`
- `@joedeleeuw/antidrift/oxlint-config` — custom drift governance and registry-aware import restrictions
- `@joedeleeuw/antidrift/policy` — functional policy checks, artifact generation, and registry validation for advanced tooling
- `antidrift` — the CLI binary for generate/check/report commands, `antidrift oxlint`, and opt-in `shell` guardrails

## Brand values

Use the brand kit when a value must be validated before it can enter the domain:

```ts
import { brand, type Brand } from "@joedeleeuw/antidrift/brand";

const UserId = brand(
  "UserId",
  (value): value is string =>
    typeof value === "string" && value.startsWith("user_")
);

type UserId = Brand<string, "UserId">;

const id = UserId.make(raw);
```

## Requirements

Node 22+ and TypeScript 5+.

## Status

MIT.
