# antidrift

A custom ESLint plugin, shareable ESLint config, and a policy generator. It exists to catch the specific ways a codebase rots when an agent is the one writing it.

Regular linters check syntax and a handful of correctness rules. They don't notice when an agent redeclares a type that already ships with `firebase`, wires up a `useEffect` with no dependency array, or quietly swallows an error to turn a red test green. Those edits compile. They pass review when the reviewer is skimming. Then they drift. You end up with three slightly different `User` types, four copies of the same fetch logic, and a component that re-renders on every keystroke.

antidrift writes those patterns down as deterministic rules so the machine catches them instead of you.

The custom rule engine is ESLint plus `typescript-eslint`. That is intentional: the core rules need TypeScript's `Program` and `TypeChecker`, not just a parsed AST. Baseline lint coverage and bespoke semantic rules both live in the ESLint layer.

The positive pattern behind the rules is one owner per concept: domain owns business vocabulary, contracts own wire schemas, API boundaries validate and authorize, gateways own SDKs, and UI consumes resource/result unions instead of local duplicate shapes.

## Install

```sh
pnpm add -D @joedeleeuw/antidrift eslint typescript typescript-eslint @typescript-eslint/parser
```

ESLint, TypeScript, typescript-eslint, and the parser are peer dependencies, so you bring your own versions: ESLint 9+, TypeScript 5+, typescript-eslint 8+.

## Use the config

Your whole `eslint.config.mjs` is one call:

```js
import { createConfig } from "@joedeleeuw/antidrift/eslint-config";

export default createConfig({ tsconfigRootDir: import.meta.dirname });
```

That gives you the type-aware base (typescript-eslint, sonarjs, architecture boundaries, react-hooks) plus every antidrift rule. It also includes the general monorepo hygiene layer: import grouping and spacing, sorted named imports, top-level `import type` declarations, package dependency checks, promise-misuse and unnecessary-condition checks, type-union/intersection sorting, React component/key conventions, JSX prop ordering, duplicate-import protection, import-cycle detection, and single-blank-line formatting. If you keep a `policy/` directory with registries, `createConfig` reads them and wires up the domain-specific rules on its own.

If you wire `@joedeleeuw/antidrift/eslint-plugin` by hand instead of using `createConfig`, configure `@typescript-eslint/parser` with parser services (`projectService` or `project`). Fully type-aware antidrift rules report a configuration error when enabled without those services so missing type information cannot silently weaken the rule set. Hybrid rules such as `antidrift/no-sql-string-concat` still run their AST and local-flow proof without parser services, but imported escaper and configured safe-member proofs are parser-service-only and are classified by the SQL benchmark.

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
    "policy:check:changed": "antidrift check-changed",
    "policy:verify-session": "antidrift verify-session"
  }
}
```

For self-hosted rule packages, these additional checks keep the control plane honest:

```sh
npx antidrift check-registries
npx antidrift check-rule-surface
npx antidrift semantic-manifest
npx antidrift rule-status
pnpm package:verify
pnpm policy:validate-corpus
pnpm policy:validate-chaski
pnpm policy:benchmark-sql-queries
pnpm policy:inventory-defensive-shape
pnpm policy:inventory-react-state
pnpm policy:inventory-schema-roundtrip
pnpm policy:inventory-underchecked-predicate
npx antidrift repo-corpus --slice current-work --rules import-x/no-cycle
```

The first two validate registry-backed rule facts and verify every custom rule exported by the plugin is configured and covered by `RuleTester`.
`semantic-manifest` prints the composed semantic adapter/fact contract registry as JSON, so downstream tools can discover proof buckets, owned associations, and emitted fact kinds without importing source internals. Use `--adapter`, `--rule`, `--proof-bucket`, `--fact-adapter`, or `--fact-kind` to print a filtered adapter slice.
`rule-status` prints a normalized view of `policy/registries/rules.yaml`, including active, retired, research, and policy-review rows, so experimental rules can ship with explicit maturity and delegation metadata. Use `--kind`, `--status`, `--semantic-adapter`, or `--proof-bucket` to print a filtered manifest. Add `--semantic-summary` to print joined summaries for the filtered rows. Proof-bucket filtering includes both semantic-adapter contracts and registry `promotion.proofBucket` rows. The policy subpath exposes the same helpers plus joined rule semantic summaries for downstream tooling.
`package:verify` packs the npm tarball, installs it in a throwaway consumer workspace, type-checks every public export under Bundler and NodeNext resolution, imports every runtime export, runs ESLint through the shipped config, proves `SEMANTIC_FACT_KINDS` and the public semantic adapters are available to consumer tooling, proves the CLI exposes the composed semantic manifest and normalized rule-status registry, and proves a configured semantic fact sink receives a generated-source `structuralMatch` fact.
`check-rule-surface` is only meaningful in this source repository layout; installed consumers can use `verify-session`, `check-generated`, and normal ESLint runs without carrying antidrift's own rule tests.
`policy:validate-corpus` lints the maintained project inventory with every custom rule, while `repo-corpus` can narrow the evidence to the rules changed in a slice.
`policy:validate-chaski` is an optional local corpus gate: it runs explicit assertions against real Chaski frontend/BFF files when `CHASKI_REPO` or `/Users/sushi/code/chaski` is available, and skips otherwise so consumers do not need the private corpus.
`policy:benchmark-sql-queries` compares `antidrift/no-sql-string-concat` with `sonarjs/sql-queries` on real SQL programs and emits `parserServiceDeltas`: extra-only non-type-aware identifier reports are inventory, while missing non-type-aware findings or parser errors block promotion.
`policy:inventory-defensive-shape` is a non-blocking sunset inventory for `no-defensive-shape-probing`. It compares the default-off custom rule with adjacent TypeScript ESLint unsafe rules under parser services and records syntax pressure separately from diagnostics.
`policy:inventory-react-state` is a non-blocking semantic fact inventory for React state co-mutation. It classifies broad setter co-mutation separately from `no-handrolled-resource-lifecycle-cells` diagnostics so broad inventory cannot become accidental enforcement. Pass `--repo` and `--targets "src/**/*.{ts,tsx}"` to scan a specific checkout; target splitting preserves brace globs.
`policy:inventory-schema-roundtrip` is a non-blocking research inventory for same-schema `.parse({ ...typedState })` shapes; it classifies real anchors instead of failing the build.
`policy:inventory-underchecked-predicate` is a non-blocking search inventory for `no-underchecked-type-predicate`. It counts type-predicate syntax pressure separately from broad-input contract-laundering diagnostics and records adjacent TypeScript ESLint unsafe-rule overlap.

## What's in the box

Public entry points, one package:

- `@joedeleeuw/antidrift` — package primitives: `createConfig`, `eslintPlugin`, policy rendering, and registry loading
- `@joedeleeuw/antidrift/brand` — `Brand<T, Name>`, `Unbrand<T>`, and `brand(name, check)`
- `@joedeleeuw/antidrift/eslint-config` — the `createConfig` factory above
- `@joedeleeuw/antidrift/eslint-plugin` — the raw plugin, if you'd rather wire rules by hand
- `@joedeleeuw/antidrift/policy` — policy check APIs, rule-status registry helpers, semantic fact sinks, and shipped `SEMANTIC_FACT_KINDS` contracts for advanced tooling
- `@joedeleeuw/antidrift/semantic-adapters` — aggregate semantic adapter registry and contracts for tooling that wants the full shared proof surface
- `@joedeleeuw/antidrift/semantic-adapters/async-control-flow` — async array callback and Promise collection-flow helpers shared by `no-async-array-method`
- `@joedeleeuw/antidrift/semantic-adapters/auth-boundary` — route-param/authz frame tracking shared by `require-authz-check`
- `@joedeleeuw/antidrift/semantic-adapters/broad-input` — broad `Object.entries` mini-parser classifiers shared by `no-defensive-shape-probing`
- `@joedeleeuw/antidrift/semantic-adapters/parse-input` — JSON.parse input provenance and local string-boundary proof shared by `no-unsafe-deserialize`
- `@joedeleeuw/antidrift/semantic-adapters/react-state` — React state graph adapter primitives for tooling that needs the same lifecycle proof used by `no-handrolled-resource-lifecycle-cells`
- `@joedeleeuw/antidrift/semantic-adapters/schema-provenance` — Zod parse/provenance helpers shared by `no-redundant-zod-parse`
- `@joedeleeuw/antidrift/semantic-adapters/sql` — SQL context, identifier-token, and safe-member classifiers shared by `no-sql-string-concat`
- `@joedeleeuw/antidrift/semantic-adapters/tuple-shape` — tuple nullish-slot classifiers shared by `no-nullable-positional-tuple`
- `@joedeleeuw/antidrift/semantic-adapters/type-owner` — TypeChecker-backed owner candidate collectors for generated, domain, and installed-package structural authority
- `antidrift` — the CLI binary for generate/check/report commands, plus `semantic-manifest` and `rule-status` for machine-readable metadata

## The rule worth installing this for

`antidrift/no-structural-type-fork` asks the TypeScript type checker, not a list of names, whether the type you just hand-wrote is structurally a copy of a configured generated-source owner. Installed package matches are semantic inventory until a project accepts the package owner as authority.

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

Generated-source and first-party domain owners come from policy registries. Installed packages are scanned only for proposal facts when a semantic fact sink is configured; they do not block by default. Alias an imported type (`type X = UserInfo`) and it stays quiet, because that's a reference and not a fork. All-optional projection DTOs stay quiet because they are usually boundary drafts or patches, not full model redeclarations.

The scoped rules that motivated this package go after the usual agent tells:

- `require-effect-deps` — a `useEffect` with no dependency array runs on every render, and `exhaustive-deps` won't say a word about it
- `no-trivial-selector-wrapper` — local selector helpers that paper over inference instead of using the existing value
- `no-nullable-positional-tuple` — tuple types with multiple nullable or optional slots where a named object or state union should carry meaning
- `no-appeasement-cast` — `any` / `unknown` casts that paper over missing validation
- `no-underchecked-type-predicate` — default-off inventory for broad-input type predicates that assert object contracts without checking required asserted fields
- `no-canonical-model-fork` — configured first-party model redeclarations that should import or derive from the canonical owner
- `no-handrolled-resource-lifecycle-cells` — behavior-based detection for hand-rolled async resource lifecycle state machines, with broad multi-setter co-mutation emitted as inventory only
- `no-unsafe-deserialize` — `JSON.parse` of `any` / `unknown` instead of parsing at a schema boundary
- `no-defensive-shape-probing` — deterministic broad-value extractor cases backed by real corpus evidence, not ordinary boolean predicates
- `import-x/no-cycle` — import cycles caught through maintained import-graph coverage

Other existing baseline rules may still ship in the config, but they are not the current roadmap.

Run `eslint` and read the messages. Each rule says what to do instead.

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
- `.claude/settings.json` and `.codex/hooks.json`, including pre/post-tool hooks that block edits to generated files and dangerous shell commands

One source of truth, regenerated on demand. `antidrift check-generated` fails CI if any of them have drifted from the policy.

## Requirements

Node 22+, ESLint 9+ (flat config), TypeScript 5+, typescript-eslint 8+, and `@typescript-eslint/parser` 8+.

## Status

This is 0.2.0, and I'll be honest about what that means. The rules have local regression tests and a real-corpus validation ledger, but some package-surface rules remain under-proven until they have source-code evidence outside reduced examples. Pin the version.

MIT.
