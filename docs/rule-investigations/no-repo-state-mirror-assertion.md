# no-repo-state-mirror-assertion

## Intent

Flag test assertions that load repo-owned state (configuration, manifests, registries) and then compare it against literal values, or pin the presence of one specific key. Such assertions restate values the repository already defines, so every legitimate tune of that state breaks the test without proving anything about behaviour. The test should assert an invariant or behaviour, or arrange the data as a fixture the test itself owns.

## Detection

The rule is AST-only and runs only on test filenames (`*.test.*`, `*.spec.*`, `test/`, `tests/`, `__tests__/`). It requires configuration: a list of repo-owned source modules, each optionally restricted to specific imported names.

```js
"antidrift/no-repo-state-mirror-assertion": [
  "error",
  {
    sources: [
      { module: "lib/config" },
      { module: "@scope/shared/registry", names: ["getEntry"] },
    ],
  },
]
```

Imports from those modules taint the local binding. Taint propagates through local aliases, member access, calls, `await`, conditional and logical expressions, and `for...of` iteration over a tainted source. Two report shapes follow:

- **`mirroredLiteral`** — an equality matcher (`toBe`, `toEqual`, `toStrictEqual`, `toMatchObject`, `toContain`, `toContainEqual`, `toHaveProperty`) whose expected arguments are literal-like (literals, literal templates, literal objects/arrays) and whose subject resolves to a tainted root.
- **`pinnedLookup`** — an existence matcher (`toBeNull`, `toBeUndefined`, `toBeDefined`, `toBeTruthy`, `toBeFalsy`) applied to a call chain on a tainted import whose arguments are all literal-like, i.e. pinning that a specific key exists.

## Controls

Without `sources` the rule still reports assertions on file contents a test reads with `readFile` or `readFileSync`; configured `sources` add imported state modules. `names` narrows a module to specific exports; omitting it taints every import from that module. Malformed options fail loudly through the rule schema.

## Ecosystem

`no-restricted-imports` blocks imports but cannot express "asserting this module's contents against literals is meaningless". `eslint-plugin-jest`'s `no-conditional-expect` and SonarQube duplicated-literal detection operate on control flow or raw token duplication, not on the provenance of an imported repo-owned module. No upstream rule models the mirrored-state signal, so the gap is owned here.

## Corpus

First drift case is a private app's client configuration and profile suite: tests compared the output of its profile-manifest and runtime-profile functions against literal profile objects and pinned specific configuration-file and scope values. The corrected forms assert relative invariants (manifest ids equal runtime-profile ids) or owned fixtures. That private app is the first clean external-corpus control.

Keep the rule default-off until taint-coverage pressure (re-exports, dynamic access, fixture helpers) is inventoried on at least one more repository.

## Off by default by owner decision (October 2026)

On 20 fresh reports from BuilderIO/agent-native, cloudflare/agents, LibreChat and opencode, each judged by whether a reviewer would ask for the change, 10 were real problems, all tests that read the repository's source as text and pin a fragment of it. The other 10 were tests reading back files the test itself wrote (6), must-not-contain checks (2) and pinned public type names (2). The preset now ships the rule `off`; a project enables it explicitly. Limiting the rule to tests that read the repository's own source is the candidate fix before it returns to the default.
