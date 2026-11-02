# antidrift

A focused Oxlint governance config, a native Rust `tsrslint` type-aware rule engine (`antidrift-linter`), and a policy generator. It exists to catch the specific ways a codebase rots when an agent is the one writing it.

Regular linters check syntax and a handful of correctness rules. They don't notice when an agent redeclares a type that already ships with `firebase`, wires up a `useEffect` with no dependency array, or quietly swallows an error to turn a red test green. Those edits compile. They pass review when the reviewer is skimming. Then they drift. You end up with three slightly different `User` types, four copies of the same fetch logic, and a component that re-renders on every keystroke.

antidrift writes those patterns down as deterministic rules so the machine catches them instead of you.

All 97 `antidrift/*` rules run in a single native Rust engine (`antidrift-linter`, built on `tsrs_ast`, `tsrs_compiler`, `tsrs_checker`, and `tsrslint`) invoked through `antidrift oxlint` or directly via `@joedeleeuw/antidrift/oxlint-plugin`. Generic TypeScript and maintained third-party rules belong to `@joedeleeuw/typescript-tooling`; consumers choose their broader React, Vitest, import-style, and repository-boundary baselines.

Antidrift's custom rules concentrate on contract ownership, boundary decoding, independent test oracles, resource lifecycles, and framework-specific proof. React, Convex, Effect, TanStack, and Bun integrations are not repository-specific. Naming, comment, layout, token, and architecture conventions are consumer policy; configure their scopes rather than treating them as universal correctness.

The positive pattern behind the rules is one owner per concept: domain owns business vocabulary, contracts own wire schemas, API boundaries validate and authorize, gateways own SDKs, and UI consumes resource/result unions instead of local duplicate shapes.

## Install

```sh
pnpm add -D @joedeleeuw/antidrift typescript
```

The native `antidrift-linter` and the Oxlint addon arrive through one optional platform package, `@joedeleeuw/antidrift-linter-<platform>`, for these platforms: `linux-x64-gnu`, `linux-arm64-gnu`, `linux-x64-musl`, `linux-arm64-musl` (Alpine), `darwin-arm64`, `win32-x64-msvc` and `win32-arm64-msvc`. On Linux the launcher reads the C library from Node's own report, so glibc and musl hosts each load their own build. Intel Macs and other hosts get no package and fail with the list above; build `crates/antidrift-linter` and `crates/antidrift-napi` yourself and point `ANTIDRIFT_LINTER_BIN` and `ANTIDRIFT_NAPI_ADDON` at the results.

Rust projects that only want `antidrift-linter rust` can skip npm. Each GitHub release carries an `antidrift-linter-<target>` archive for every platform above, which `cargo binstall` downloads; `cargo install` builds from source instead:

```sh
cargo binstall --git https://github.com/joedeleeuw/antidrift antidrift-linter
cargo install --git https://github.com/joedeleeuw/antidrift --locked antidrift-linter
```

## Default Ruleset

`antidrift/no-wrapping-functions` runs as a typed rule in `antidrift-linter` that inlines each candidate in memory and reports only verified hops. Named functions and named arrows that only delegate to another call, read a parameter property, or apply a literal property fallback must earn their extra layer through a concrete boundary or callback requirement. Exports are included. Anonymous inline callbacks, calculations, argument transformations and functions that own additional behavior stay outside the rule. It provides no automatic fix. When removing a callback adapter, preserve its exact signature, receiver behavior, hook position and stable identity; pass the existing owner directly only when it already satisfies that callback contract.

The default `antidrift-linter` ruleset also enforces shared AGENT.md directives recorded in `policy/agent-guardrails.yaml`: `antidrift/no-anemic-errors` (G7), `antidrift/no-dated-comments` (S5), `antidrift/no-host-path-literal` (S4), `antidrift/no-pass-through-parameters` (G22), and `antidrift/no-compat-names` (G5) (`antidrift/no-vague-names` for G21 remains registered for explicit opt-in). G8 maps to native `no-nested-ternary`, owned by `@joedeleeuw/typescript-tooling`. G9 maps to `unicorn-js/prefer-switch` there.

Size caps come from one kernel table shared with the Rust self-lint. `antidrift/max-module-lines` warns above 425 lines and errors above 500, `antidrift/max-function-lines` warns above 40 and errors above 50, and `antidrift/max-component-lines` warns above 150 and errors above 180 for PascalCase functions that render JSX. Blank and comment lines count. Describe-style suite callbacks are containers, so they are exempt; `it` and `test` bodies are not. Generated-looking file names get no exemption; declare codegen output in `policy/registries/generated.yaml` to exclude it. If your base config enables Oxlint `max-lines` or `max-lines-per-function`, turn them off so each size has one owner. Oxlint reports every antidrift diagnostic at error, so under Oxlint the warn tier blocks too.

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
  jsPlugins: [...(tooling.jsPlugins ?? []), ...governance.jsPlugins],
  settings: { ...tooling.settings, ...governance.settings },
  rules: {
    ...tooling.rules,
    ...governance.rules,
    "max-lines": "off",
    "max-lines-per-function": "off",
    "antidrift/no-as-never": "warn",
    "antidrift/no-explicit-type-arguments-on-owned-api": "error",
    "antidrift/no-identity-schema-transform": "error",
    "antidrift/no-schema-validator-transcoding": "error",
    "antidrift/react-max-component-props": ["error", { max: 6 }],
    "antidrift/require-convex-return-validator": "off",
  },
  ignorePatterns: [
    ...new Set([...governance.ignorePatterns, ...tooling.ignorePatterns]),
  ],
  overrides: [
    ...(tooling.overrides ?? []),
    ...governance.overrides,
    {
      files: ["apps/client/convex/**/*.ts"],
      rules: { "antidrift/require-convex-return-validator": "error" },
    },
    {
      files: ["apps/client/src/legacy-card.tsx"],
      rules: { "antidrift/react-max-component-props": "off" },
    },
  ],
};
```

The governance config registers the antidrift Oxlint plugin (`jsPlugins`) and turns on every default `antidrift/*` rule at `error`, plus antidrift's import restrictions, ignore patterns and overrides. Categories, other plugins, `denyWarnings` and unused-directive reporting stay with your config. Because the rules are plugin rules, Oxlint owns their severity (`"warn"`, `"error"`, `"off"`), `overrides` file globs, rule options (the ESLint options array) and `oxlint-disable` directives, and reports them as `antidrift(rule-name)`. The plugin exposes both `createOnce(context)` for Oxlint and standard `create(context)` for ESLint and Bun hosts, keying its per-file batch memo by `(context.cwd, context.filename)`. Keep `jsPlugins` from the governance config in a composed config: `antidrift oxlint` refuses to run when the resolved config does not register the plugin, because no antidrift rule would run. The rules themselves execute in the native engine behind the plugin; the type-aware helper (`OXLINT_TSGOLINT_PATH`) serves only the typed rules Oxlint requests. Declaration files are ignored by the governance `ignorePatterns`; drop those entries to lint them.

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

## Rust workspaces

`antidrift-linter rust` carries the same drift rules to Rust: one owner per type, decode at the boundary, keep error causes, no pass-through hops, no grab-bag or orphan modules. Install it from the repository and run it at the workspace root:

```sh
cargo install --git https://github.com/joedeleeuw/antidrift --locked antidrift-linter
antidrift-linter rust .
antidrift-linter rust --list-rules .
```

Every general rule is on at `error` with no configuration. Rule levels, per-rule file scopes, crate and module layering, and forbidden calls live in the workspace `Cargo.toml` under `[workspace.metadata.antidrift]` (`[package.metadata.antidrift]` for a crate outside any workspace). The table is decoded once with unknown keys, unknown rule ids and invalid levels rejected by name:

```toml
[workspace.metadata.antidrift]
rules."rust/no-inline-comment" = "error"
rules."rust/require-strict-serde" = { level = "error", exclude-files = ["crates/app/src/cargo_manifest.rs"] }
layers.crates = ["app-kernel", "app-rules", "app-engine"]
layers.modules.app-kernel = ["provenance", "shape", "boundary"]

[[workspace.metadata.antidrift.forbidden-calls]]
callee = "Listener::Enter"
argument = "Kind::SourceFile"
reason = "Listener::Enter(Kind::SourceFile) never fires in tsrslint."
```

Levels are `error`, `warn` or `off`; `files` and `exclude-files` take globs relative to the manifest. `layers.crates` and `layers.modules` order crates (and a crate's top-level modules) from lowest to highest; a lower layer may not depend on a higher one, and `rust/no-layer-violation` stays silent until you declare layers. Generated files (`@generated`, `DO NOT EDIT`, `generated/` directories) report nothing, and `#[cfg(test)]` code is exempt from the rules whose TypeScript counterparts skip test files.

Two house-style rules ship off and are opt-in through the same table: `rust/no-inline-comment` (rationale goes in the commit body) and `rust/no-inline-tests` (no `#[test]` or `#[cfg(test)]`, and `test = false` / `doctest = false` on Cargo targets). This repository turns both on.

## What's in the box

Public entry points, one package:

- `@joedeleeuw/antidrift` — package primitives: `createGovernanceOxlintConfig`, policy rendering, and registry loading
- `@joedeleeuw/antidrift/package.json` — package metadata for consumer tooling
- `@joedeleeuw/antidrift/brand` — `Brand<T, Name>`, `Unbrand<T>`, and `brand(name, check)`
- `@joedeleeuw/antidrift/oxlint-config` — custom drift governance and registry-aware import restrictions
- `@joedeleeuw/antidrift/oxlint-plugin` — the Oxlint JS plugin that runs every `antidrift/*` rule in the native engine; the governance config registers it
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

Node 24+ and TypeScript 5+.

## Status

MIT.
