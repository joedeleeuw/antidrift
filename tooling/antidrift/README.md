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

That gives you the type-aware base (typescript-eslint, sonarjs, architecture boundaries, react-hooks) plus every antidrift rule. If you keep a `policy/` directory with registries, `createConfig` reads them and wires up the domain-specific rules on its own.

Generate policy artifacts when `policy/agent-guardrails.yaml` changes:

```sh
npx antidrift generate
```

That writes the agent instruction files and hook configs (more on those below).

For self-hosted rule packages, two additional checks keep the control plane honest:

```sh
npx antidrift check-registries
npx antidrift check-rule-surface
pnpm policy:validate-corpus
pnpm policy:validate-chaski
npx antidrift repo-corpus --slice current-work --rules import-x/no-cycle
```

The first validates registry-backed rule facts. The second verifies every custom rule exported by the plugin is configured and covered by `RuleTester`.
`policy:validate-corpus` lints the maintained project inventory with every custom rule, while `repo-corpus` can narrow the evidence to the rules changed in a slice.
`policy:validate-chaski` is an optional local corpus gate: it runs explicit assertions against real Chaski frontend/BFF files when `CHASKI_REPO` or `/Users/sushi/code/chaski` is available, and skips otherwise so consumers do not need the private corpus.

## What's in the box

Public entry points, one package:

- `@joedeleeuw/antidrift` — stable primitives: `createConfig`, `eslintPlugin`, policy rendering, and registry loading
- `@joedeleeuw/antidrift/brand` — `Brand<T, Name>`, `Unbrand<T>`, and `brand(name, check)`
- `@joedeleeuw/antidrift/eslint-config` — the `createConfig` factory above
- `@joedeleeuw/antidrift/eslint-plugin` — the raw plugin, if you'd rather wire rules by hand
- `@joedeleeuw/antidrift/policy` — policy check APIs for advanced tooling
- `antidrift` — the CLI binary for generate/check/report commands

## The rule worth installing this for

`antidrift/no-structural-type-fork` asks the TypeScript type checker, not a list of names, whether the type you just hand-wrote is structurally a copy of one already exported by an installed package or a configured generated-source owner.

```ts
// firebase/auth already exports this exact shape.
// antidrift flags it: import it instead of redeclaring.
type AuthUser = {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
  providerId: string;
  phoneNumber: string | null;
};
```

There's no registry of "known types" to keep up to date. It reads whatever your project imports, so installing `twilio` or `firebase` makes their types canonical automatically. Alias an imported type (`type X = UserInfo`) and it stays quiet, because that's a reference and not a fork. Make every field optional and it still fires, because that's the same shape with the guardrails filed off.

The scoped rules that motivated this package go after the usual agent tells:

- `require-effect-deps` — a `useEffect` with no dependency array runs on every render, and `exhaustive-deps` won't say a word about it
- `no-trivial-selector-wrapper` — local selector helpers that paper over inference instead of using the existing value
- `no-nullable-positional-tuple` — tuple types with multiple nullable or optional slots where a named object or state union should carry meaning
- `no-cast-to-branded` / `no-appeasement-cast` — casts that paper over missing validation or branding
- `no-underchecked-type-predicate` — broad-input type predicates that assert object contracts without checking asserted fields
- `no-canonical-model-fork` — configured first-party model redeclarations that should import or derive from the canonical owner
- `no-status-triplet-state` — configurable detection for `data` / `loading` / `error` state cells that should be one resource value
- `no-unsafe-deserialize` — `JSON.parse` of `any` / `unknown` instead of parsing at a schema boundary
- `no-defensive-shape-probing` — deterministic broad-value extractor cases backed by real corpus evidence, not ordinary boolean predicates
- `import-x/no-cycle` — import cycles caught through maintained import-graph coverage

Other existing baseline rules may still ship in the config, but they are not the current roadmap.

Run `eslint` and read the messages. Each rule says what to do instead.

## Brand values

Use the brand kit when a value must be validated before it can enter the domain:

```ts
import { brand, type Brand } from "@joedeleeuw/antidrift/brand";

const UserId = brand("UserId", (value): value is string => typeof value === "string" && value.startsWith("user_"));

type UserId = Brand<string, "UserId">;

const id = UserId.make(raw);
```

Consumer code should obtain branded values from `make`, `safe`, `is`, or a schema boundary. `antidrift/no-cast-to-branded` rejects `raw as UserId`.

## The part that isn't lint

`antidrift generate` reads one file, `policy/agent-guardrails.yaml`, and writes the instruction files your coding agents actually read:

- `CLAUDE.md`, `AGENTS.md`, `.github/copilot-instructions.md`
- `.cursor/rules/*.mdc`
- `.claude/settings.json` and `.codex/hooks.json`, including pre/post-tool hooks that block edits to generated files and dangerous shell commands

One source of truth, regenerated on demand. `antidrift check-generated` fails CI if any of them have drifted from the policy.

## Requirements

Node 22+, ESLint 9+ (flat config), TypeScript 5+, typescript-eslint 8+, and `@typescript-eslint/parser` 8+.

## Status

This is 0.1.0, and I'll be honest about what that means. The rules have local regression tests and a real-corpus validation ledger, but some package-surface rules remain under-proven until they have source-code evidence outside reduced examples. Pin the version.

MIT.
