# antidrift

A focused Oxlint governance config and plugin, a reduced ESLint TypeChecker pass, and a policy generator. It exists to catch the specific ways a codebase rots when an agent is the one writing it.

Regular linters check syntax and a handful of correctness rules. They don't notice when an agent redeclares a type that already ships with `firebase`, wires up a `useEffect` with no dependency array, or quietly swallows an error to turn a red test green. Those edits compile. They pass review when the reviewer is skimming. Then they drift. You end up with three slightly different `User` types, four copies of the same fetch logic, and a component that re-renders on every keystroke.

antidrift writes those patterns down as deterministic rules so the machine catches them instead of you.

Oxlint owns syntax-only custom rules and shared governance. ESLint owns only the custom rules that need TypeScript's `Program` and `TypeChecker`. Generic TypeScript, React, Vitest, Unicorn, import-style, and repository-boundary policy belongs to each consumer. No custom rule ID is exported by both plugins.

The positive pattern behind the rules is one owner per concept: domain owns business vocabulary, contracts own wire schemas, API boundaries validate and authorize, gateways own SDKs, and UI consumes resource/result unions instead of local duplicate shapes.

## Install

```sh
pnpm add -D @joedeleeuw/antidrift oxlint eslint typescript typescript-eslint @typescript-eslint/parser
```

Oxlint 1.75+ and `oxlint-tsgolint` 7 are required for the stable type-aware pass. That pass uses TypeScript 7 semantics and requires a TypeScript 7-compatible `tsconfig`; it does not use the workspace's installed TypeScript package. ESLint 9.38+ or 10.x, TypeScript 5+, typescript-eslint 8+, and `@typescript-eslint/parser` remain required for the custom TypeChecker-rule pass.

## Stability

Experimental inventory commands, semantic fact payloads, registry metadata, and research rules are distributable evidence surfaces, not backward-compatible APIs. They may change between releases until promoted. Invalid configuration should fail loudly instead of falling back to weaker analysis.

## Use the configs

Create the root Oxlint config:

```ts
import {
  antidriftComplexityRules,
  createGovernanceOxlintConfig,
} from "@joedeleeuw/antidrift/oxlint-config";

const governance = createGovernanceOxlintConfig({
  repoRoot: import.meta.dirname,
});

export default {
  ...governance,
  overrides: [
    ...(governance.overrides ?? []),
    {
      files: ["src/**/*.{ts,tsx}"],
      excludeFiles: ["**/*.{test,spec}.{ts,tsx}"],
      rules: antidriftComplexityRules,
    },
  ],
};
```

Keep the ESLint config as the reduced TypeChecker pass:

```js
import { createConfig } from "@joedeleeuw/antidrift/eslint-config";

export default createConfig({ tsconfigRootDir: import.meta.dirname });
```

`createGovernanceOxlintConfig` enables registry-derived generated-code exclusions and restricted imports, gateway exemptions, anti-suppression rules, a global 1,500-line module ceiling, `antidrift/require-effect-deps`, `antidrift/no-static-property-loop`, and the imported rules for unknown aliases and chained assertions. The remaining imported rules stay registered but default-off because their syntax is not sufficient general evidence at runtime, test, and external-data boundaries. Other syntax, scope, and local-control-flow Antidrift rules are also registered as default-off inventory. The config deliberately does not choose a generic correctness, React, Vitest, Unicorn, import-style, or repository-boundary baseline. Consumers can apply the frozen `antidriftComplexityRules` fragment to deliberate production-code scopes. `createConfig` enables the custom rules that need TypeScript parser services and keeps `no-defensive-shape-probing`, `no-explicit-type-arguments-on-owned-api`, `no-identity-schema-transform`, `no-redundant-local-return-type`, `no-schema-validator-transcoding`, `no-sql-string-concat`, `no-underchecked-type-predicate`, and `require-convex-return-validator` as explicit default-off inventory. The structural and canonical owner rules load `generated.yaml`, optional `ownership.yaml`, and `domain.yaml` from the consumer's policy directory.

Oxlint excludes generated output only when its exact file or directory is declared by `policy/registries/generated.yaml` under `generatedSources[*].generated`. Generated-looking names are ordinary linted code unless the registry owns them.

The governance config does not enable `options.typeAware` or `options.typeCheck`. A consumer that selects Oxlint's type-aware TypeScript rules must enable `options.typeAware`, install `oxlint-tsgolint`, and scope those rules to TypeScript files. The repository's TypeScript compiler remains the owner of compiler diagnostics through its typecheck command.

If you wire `@joedeleeuw/antidrift/eslint-plugin` by hand instead of using `createConfig`, configure `@typescript-eslint/parser` with parser services (`projectService` or `project`). Fully type-aware antidrift rules report a configuration error when enabled without those services so missing type information cannot silently weaken the rule set. Hybrid rules such as `antidrift/no-sql-string-concat` still run their AST and local-flow proof without parser services, but imported escaper, configured safe-member, and configured declaration-source safe-template-member proofs are parser-service-only and are classified by the SQL benchmark.

To collect non-blocking semantic inventory facts, pass a fact sink through `createConfig`:

```js
import { createConfig } from "@joedeleeuw/antidrift/eslint-config";
import { createMemoryFactSink } from "@joedeleeuw/antidrift/policy";

const sink = createMemoryFactSink();

export default createConfig({
  tsconfigRootDir: import.meta.dirname,
  semanticFacts: { repoRoot: import.meta.dirname, sink },
});
```

Generate policy artifacts when `policy/agent-guardrails.yaml` changes:

```sh
npx antidrift generate
```

That writes the agent instruction files and hook configs (more on those below).
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

For self-hosted rule packages, these additional checks keep the control plane honest:

```sh
npx antidrift check-registries
npx antidrift check-rule-surface
npx antidrift shell
npx antidrift shell test
npx antidrift semantic-manifest
npx antidrift rule-status
pnpm package:verify
pnpm policy:validate-corpus
pnpm policy:validate-chaski
pnpm policy:benchmark-sql-queries
pnpm policy:inventory-change-contract
pnpm policy:validate-change-contract-evidence
pnpm policy:inventory-diff-scoped-adapters
pnpm policy:inventory-defensive-shape
pnpm policy:inventory-declaration-clone
pnpm policy:inventory-declaration-clone-source-fleet
pnpm policy:inventory-react-state
pnpm policy:inventory-schema-roundtrip
pnpm policy:inventory-type-owner
pnpm policy:inventory-underchecked-predicate
npx antidrift repo-corpus --slice current-work --rules import/no-cycle
```

The first two validate registry-backed rule facts and verify every custom rule is exported, configured, mature enough for its severity, and enabled by at most one runtime. Plugin tests own executable bad and clean behavior evidence; the surface check does not duplicate that evidence in a corpus manifest.
`shell` runs the packaged ast-grep shell guardrails against the current project. It is opt-in source lint for shell scripts, not an ESLint rule and not an automatic hook installer. `antidrift shell test` validates the packaged ast-grep rule tests.
`semantic-manifest` prints the composed semantic adapter/fact contract registry as JSON, so downstream tools can discover proof buckets, owned associations, and emitted fact kinds without importing source internals. Use `--adapter`, `--rule`, `--proof-bucket`, `--fact-adapter`, or `--fact-kind` to print a filtered adapter slice.
`rule-status` prints a normalized view of `policy/registries/rules.yaml`, including active, retired, research, and policy-review rows, so experimental rules can ship with explicit maturity and delegation metadata. Use `--kind`, `--status`, `--semantic-adapter`, or `--proof-bucket` to print a filtered manifest. Add `--semantic-summary` to print joined summaries for the filtered rows. Proof-bucket filtering includes both semantic-adapter contracts and registry `promotion.proofBucket` rows. The policy subpath exposes the same helpers plus joined rule semantic summaries for downstream tooling.
`oxlint` runs the repository's root Oxlint config through the packaged binary. The repository root composes governance with its own native and type-aware lint choices, local complexity scope, and boundary graph.
`package:verify` packs the npm tarball, installs it in a throwaway consumer workspace, type-checks every public export under Bundler and NodeNext resolution, imports every runtime export, runs the shipped lint configs, proves `SEMANTIC_FACT_KINDS` and the public semantic adapters are available to consumer tooling, proves the CLI exposes the composed semantic manifest and normalized rule-status registry, and proves a configured semantic fact sink receives a generated-source `structuralMatch` fact.
`check-rule-surface` is only meaningful in this source repository layout; installed consumers can use `verify-session`, `check-generated`, and the normal Oxlint and reduced ESLint passes without carrying Antidrift's own rule tests.
`policy:validate-corpus` exercises the remaining ESLint-owned rules against the maintained project inventory; the normal Oxlint pass covers Oxlint-owned rules. `repo-corpus` can narrow ESLint evidence to the rules changed in a slice, while the Chaski corpus executes native Oxlint cases directly where ownership moved.
`policy:validate-chaski` is an optional local corpus gate: it runs explicit assertions against real Chaski frontend/BFF files when `CHASKI_REPO` or `/Users/sushi/code/chaski` is available, and skips otherwise so consumers do not need the private corpus.
`policy:benchmark-sql-queries` runs `antidrift/no-sql-string-concat` on real SQL programs and emits `parserServiceDeltas`: extra-only non-type-aware identifier reports are inventory, while missing non-type-aware findings or parser errors block promotion.
`policy:inventory-change-contract` runs the inventory-only change-contract spine. Missing contracts exit 0, invalid contracts fail loudly, and present contracts compare merge-base change surfaces against declared paths, dependencies, exports, and optional module graph radius (`--tsconfig` is required when graph entrypoints are declared).
`policy:validate-change-contract-evidence` replays the documented change-contract MVP gold true-positive and true-negative commits against local `sudocode-main` and `chaski` clones. It fails loudly when a required repo or SHA is unavailable, writes `reports/change-contract-evidence.json`, and is a source-repo evidence gate rather than a consumer requirement.
`policy:inventory-diff-scoped-adapters` runs existing ESLint adapters against changed JS/TS files and filters diagnostics plus semantic facts to changed patch hunks. It is an inventory proof filter over the diff, not a blocking gate.
`policy:inventory-defensive-shape` is a non-blocking sunset inventory for `no-defensive-shape-probing`. It compares the default-off custom rule with adjacent TypeScript ESLint unsafe rules under parser services and records syntax pressure separately from diagnostics.
`policy:inventory-declaration-clone` is a non-blocking research inventory for duplicate object contract declarations. It uses the TypeScript checker to group interface declarations and literal object type aliases by exact declared-member name/type/optional/readonly fingerprints, and separates generated-only, mixed generated/source, and source-only clone groups. `policy:inventory-declaration-clone-source-fleet` runs the same inventory against configured local real-code corpora for promotion evidence mining.
`policy:inventory-react-state` is a non-blocking semantic fact inventory for React state co-mutation. It classifies broad setter co-mutation separately from `no-handrolled-resource-lifecycle-cells` diagnostics so broad inventory cannot become accidental enforcement. Pass `--repo` and `--targets "src/**/*.{ts,tsx}"` to scan a specific checkout; target splitting preserves brace globs.
`policy:inventory-schema-roundtrip` is a non-blocking research inventory for same-schema `.parse({ ...typedState })` shapes; it classifies real anchors instead of failing the build.
`policy:inventory-type-owner` is a non-blocking proposal inventory for structural type ownership. It scans local type alias and interface declarations per repo plan, classifies them against installed-package, registry generated-source, and implicit Convex generated owner candidates with the structural relation engine, and emits owner-match rows (test files tagged) plus ready-to-accept `ownership.yaml` `packageTypeOwners` proposals for exact installed-package copies.
`policy:inventory-underchecked-predicate` is a non-blocking search inventory for `no-underchecked-type-predicate`. It counts type-predicate syntax pressure separately from broad-input contract-laundering diagnostics and records adjacent TypeScript ESLint unsafe-rule overlap.

## Publishing

The normal release path is `.github/workflows/publish-antidrift.yml` using npm Trusted Publishing. Configure the package on npmjs.com after the package exists:

- Publisher: GitHub Actions
- Organization or user: `joedeleeuw`
- Repository: `antidrift`
- Workflow filename: `publish-antidrift.yml` (filename only, not `.github/workflows/publish-antidrift.yml`)
- Environment name: `npm-publish`
- Allowed action: `npm publish`

Release flow:

1. Bump `tooling/antidrift/package.json` to the version being released.
2. Publish a GitHub release tagged `antidrift-v<version>`.
3. The workflow verifies the tag matches the package version, runs the package checks, packs the tarball, and publishes from `tooling/antidrift`.

The workflow uses OIDC trusted publishing rather than a long-lived `NPM_TOKEN`. npm generates provenance automatically for trusted publishes from a public GitHub-hosted workflow.

For the initial publication, if `npm view @joedeleeuw/antidrift` still returns 404 and npmjs.com does not expose package settings yet, do one interactive owner publish from `tooling/antidrift` after `pnpm package:verify`, then immediately configure the Trusted Publisher above and restrict token-based publishing in npm package settings.

## What's in the box

Public entry points, one package:

- `@joedeleeuw/antidrift` — package primitives: `createGovernanceOxlintConfig`, `antidriftComplexityRules`, `oxlintPlugin`, the reduced `createConfig`/`eslintPlugin` TypeChecker pass, policy rendering, and registry loading
- `@joedeleeuw/antidrift/package.json` — package metadata for consumer tooling
- `@joedeleeuw/antidrift/brand` — `Brand<T, Name>`, `Unbrand<T>`, and `brand(name, check)`
- `@joedeleeuw/antidrift/eslint-config` — the `createConfig` factory above
- `@joedeleeuw/antidrift/eslint-plugin` — the TypeChecker plugin, if you'd rather wire those rules by hand
- `@joedeleeuw/antidrift/oxlint-config` — focused governance plus the immutable opt-in complexity fragment
- `@joedeleeuw/antidrift/oxlint-plugin` — syntax-only custom rules supported by Oxlint's JavaScript plugin API
- `@joedeleeuw/antidrift/policy` — policy check APIs, rule-status registry helpers, semantic fact sinks, and shipped `SEMANTIC_FACT_KINDS` contracts for advanced tooling
- `@joedeleeuw/antidrift/semantic-adapters` — aggregate semantic adapter registry and contracts for tooling that wants the full shared proof surface
- `@joedeleeuw/antidrift/semantic-adapters/async-control-flow` — async array callback and Promise collection-flow helpers shared by `no-async-array-method`
- `@joedeleeuw/antidrift/semantic-adapters/auth-boundary` — route-param/authz frame tracking shared by `require-authz-check`
- `@joedeleeuw/antidrift/semantic-adapters/broad-input` — broad `Object.entries` mini-parser classifiers shared by `no-defensive-shape-probing`
- `@joedeleeuw/antidrift/semantic-adapters/parse-input` — JSON.parse input provenance and local string-boundary proof shared by `no-unsafe-deserialize`
- `@joedeleeuw/antidrift/semantic-adapters/react-state` — React state graph adapter primitives for tooling that needs the same lifecycle proof used by `no-handrolled-resource-lifecycle-cells`
- `@joedeleeuw/antidrift/semantic-adapters/schema-provenance` — Zod transform and parse/provenance helpers shared by `no-identity-schema-transform` and `no-redundant-zod-parse`
- `@joedeleeuw/antidrift/semantic-adapters/sql` — SQL context, identifier-token, safe-member, and import/declaration-source safe-template-tag classifiers shared by `no-sql-string-concat`
- `@joedeleeuw/antidrift/semantic-adapters/tuple-shape` — tuple nullish-slot classifiers shared by `no-nullable-positional-tuple`
- `@joedeleeuw/antidrift/semantic-adapters/type-owner` — TypeChecker-backed owner candidate collectors for generated, domain, and installed-package structural authority
- `antidrift` — the CLI binary for generate/check/report commands, opt-in `shell` guardrails, plus `semantic-manifest` and `rule-status` for machine-readable metadata

## The rule worth installing this for

`antidrift/no-structural-type-fork` asks the TypeScript type checker, not a list of names, whether the type you just hand-wrote is structurally a copy of a configured generated-source owner. Installed package matches are semantic inventory until a project accepts the package owner as authority. Convex generated owners are implicit: when the program contains `convex/_generated/dataModel` or `convex/_generated/api`, every `Doc<"table">` and every `FunctionReturnType<typeof api.*>` is an accepted owner with no registry entry, and exact hand-written copies report while references, `Pick`/`Omit` projections, and near-miss shapes stay silent.

```ts
// A configured generated owner already exports this exact shape.
// antidrift flags it: import or derive from that owner instead.
type ReleaseRow = {
  id: string;
  appId: string;
  version: string;
  status: "draft" | "submitted" | "released";
  createdAt: number;
};
```

Generated-source and first-party domain owners come from policy registries. Convex generated owners need no registry entry: any `convex/_generated/dataModel` or `convex/_generated/api` module in the program supplies accepted `Doc<"table">` and `FunctionReturnType<typeof api.*>` owners, and files under `convex/_generated/` are exempt. Installed packages are scanned only for proposal facts when a semantic fact sink is configured; they do not block by default. Alias an imported type (`type X = UserInfo`) and it stays quiet, because that's a reference and not a fork. All-optional projection DTOs stay quiet because they are usually boundary drafts or patches, not full model redeclarations.

The scoped rules that motivated this package go after the usual agent tells:

- `require-effect-deps` — a `useEffect` with no dependency array runs on every render, and `exhaustive-deps` won't say a word about it
- `no-static-property-loop` — tests that loop over hardcoded keys only to restate one precomputed object's static values
- `react-max-component-props` — JSX-returning React components with too many locally-owned accepted props
- `no-contract-appeasement-projection` — internal helpers that project one owned value contract into another explicit return contract without construction or validation
- `no-nullable-positional-tuple` — tuple types with multiple nullable or optional slots where a named object or state union should carry meaning
- `no-appeasement-cast` — `any` / `unknown` casts that paper over missing validation
- `no-underchecked-type-predicate` — default-off inventory for broad-input type predicates that assert object contracts without checking required asserted fields
- `no-canonical-model-fork` — configured first-party model redeclarations that should import or derive from the canonical owner
- `no-handrolled-resource-lifecycle-cells` — behavior-based detection for hand-rolled async resource lifecycle state machines, with broad multi-setter co-mutation emitted as inventory only
- `no-unsafe-deserialize` — `JSON.parse` of `any` / `unknown` instead of parsing at a schema boundary
- `no-defensive-shape-probing` — deterministic broad-value extractor cases backed by real corpus evidence, not ordinary boolean predicates
- `no-identity-schema-transform` — default-off TypeChecker proof for Zod transforms that reconstruct every input field unchanged
- `no-explicit-type-arguments-on-owned-api` — default-off symbol-resolved proof against caller-supplied type arguments on Convex generated references and TanStack registrations
- `require-convex-return-validator` — default-off symbol-resolved proof that every registered Convex function declares an explicit `returns` validator
- `no-schema-validator-transcoding` — default-off proof against an Effect `JSONSchema.make` result registered as a Convex validator instead of keeping one runtime owner
- `no-redundant-local-return-type` — default-off TypeChecker identity proof for a nested implementation whose shorthand-object inference repeats a direct named type literal while every call remains constrained by the enclosing function's explicit return contract
- `import/no-cycle` — import cycles caught by Oxlint's native import graph

Other existing baseline rules may still ship in the config, but they are not the current roadmap.

Run `eslint` and read the messages. Each rule says what to do instead.

## Shell guardrails

`antidrift shell` runs Antidrift's packaged ast-grep rule pack against the current project. Install `ast-grep` with your OS/toolchain package manager and keep it on `PATH`, or pass `AST_GREP_BIN` / `--ast-grep-bin` when your environment pins binaries elsewhere:

```sh
npx antidrift shell
```

The first packaged shell rule is `no-swallowed-command-substitution-status`. It flags captured command output whose producing command status is erased:

```sh
status="$(curl -sS "$url")" || true
status="$(curl -sS "$url" || true)"
```

Preserve the exit status explicitly instead:

```sh
if status="$(curl -sS "$url")"; then
  rc=0
else
  rc=$?
fi
```

Projects can wire this into their own hook runner or CI:

```json
{
  "scripts": {
    "guardrails:shell": "antidrift shell"
  },
  "simple-git-hooks": {
    "pre-commit": "pnpm guardrails:shell"
  }
}
```

The package does not auto-install hooks. For pre-commit users, call the same command from a local hook entry.

## Brand values

Use the brand kit when a value must be validated before it can enter the domain:

```ts
import { brand, type Brand } from "@joedeleeuw/antidrift/brand";

const UserId = brand(
  "UserId",
  (value): value is string =>
    typeof value === "string" && value.startsWith("user_"),
);

type UserId = Brand<string, "UserId">;

const id = UserId.make(raw);
```

Consumer code should obtain branded values from `make`, `safe`, `is`, or a schema boundary. The package keeps the brand utility, but the former custom brand-cast lint rule is retired until real consumer adoption and non-test forgery evidence justify reopening it.

## The part that isn't lint

`antidrift generate` reads one file, `policy/agent-guardrails.yaml`, and writes the instruction files your coding agents actually read:

- `CLAUDE.md`, `AGENTS.md`, `.github/copilot-instructions.md`
- `.cursor/rules/*.mdc`
- `.claude/settings.json` and `.codex/hooks.json`, including pre/post-tool hooks that block edits to generated files and run repo verification

One source of truth, regenerated on demand. `antidrift check-generated` fails CI if any of them have drifted from the policy.

## Requirements

Node 22+, ESLint 9.38+ or 10.x (flat config), TypeScript 5+, typescript-eslint 8+, and `@typescript-eslint/parser` 8+.

## Status

This is an early 0.x release, and I'll be honest about what that means. The rules have local regression tests and a real-corpus validation ledger, but some package-surface rules remain under-proven until they have source-code evidence outside reduced examples. Pin the version.

MIT.
