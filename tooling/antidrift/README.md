# antidrift

A custom ESLint plugin, shareable ESLint and Oxlint configs, and a policy generator. It exists to catch the specific ways a codebase rots when an agent is the one writing it.

Regular linters check syntax and a handful of correctness rules. They don't notice when an agent redeclares a type that already ships with `firebase`, wires up a `useEffect` with no dependency array, or quietly swallows an error to turn a red test green. Those edits compile. They pass review when the reviewer is skimming. Then they drift. You end up with three slightly different `User` types, four copies of the same fetch logic, and a component that re-renders on every keystroke.

antidrift writes those patterns down as deterministic rules so the machine catches them instead of you.

## Install

```sh
pnpm add -D @joedeleeuw/antidrift eslint typescript-eslint @typescript-eslint/parser
```

ESLint, typescript-eslint, and the parser are peer dependencies, so you bring your own versions: ESLint 9+, typescript-eslint 8+.

## Use the config

Your whole `eslint.config.mjs` is one call:

```js
import { createConfig } from "@joedeleeuw/antidrift/eslint-config";

export default createConfig({ tsconfigRootDir: import.meta.dirname });
```

That gives you the type-aware base (typescript-eslint, sonarjs, architecture boundaries, react-hooks) plus every antidrift rule. If you keep a `policy/` directory with registries, `createConfig` reads them and wires up the domain-specific rules on its own.

Oxlint runs as a fast first pass. It reads JSON instead of a JS config, so you generate its file:

```sh
npx antidrift generate
```

That writes a `.oxlintrc.json` Oxlint discovers by itself, plus the agent instruction files (more on those below).

## What's in the box

Four entry points, one package:

- `@joedeleeuw/antidrift/eslint-config` — the `createConfig` factory above
- `@joedeleeuw/antidrift/eslint-plugin` — the raw plugin, if you'd rather wire rules by hand
- `@joedeleeuw/antidrift/oxlint-config` — the Oxlint baseline object
- `@joedeleeuw/antidrift` — the policy API and the `antidrift` CLI

## The rule worth installing this for

`antidrift/no-structural-type-fork` asks the TypeScript type checker, not a list of names, whether the type you just hand-wrote is structurally a copy of one already exported by an installed package.

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

The rest of the rules go after the usual agent tells. A few:

- `require-effect-deps` — a `useEffect` with no dependency array runs on every render, and `exhaustive-deps` won't say a word about it
- `no-silent-catch` — empty `catch` blocks that hide failures
- `no-coupled-state-setters` / `no-status-triplet-state` — `useState` sprawl that's really one state machine
- `no-sql-string-concat`, `no-unsafe-deserialize`, `require-authz-check` — the security ones

Run `eslint` and read the messages. Each rule says what to do instead.

## The part that isn't lint

`antidrift generate` reads one file, `policy/agent-guardrails.yaml`, and writes the instruction files your coding agents actually read:

- `CLAUDE.md`, `AGENTS.md`, `.github/copilot-instructions.md`
- `.cursor/rules/*.mdc`
- `.claude/settings.json` and `.codex/hooks.json`, including pre/post-tool hooks that block edits to generated files and dangerous shell commands
- `.oxlintrc.json`

One source of truth, regenerated on demand. `antidrift check-generated` fails CI if any of them have drifted from the policy.

## Requirements

Node 22+, ESLint 9+ (flat config), typescript-eslint 8+, and `@typescript-eslint/parser` 8+.

## Status

This is 0.1.0, and I'll be honest about what that means. The rules are tested (94 tests, with the type-fork detector run against a matrix of real programs: clean imports, redeclarations, zod-inferred mirrors, multi-file drift), but the API can still move before 1.0. Pin the version.

MIT.
