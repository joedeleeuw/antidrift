# Directive rules

Status: implemented; default error in the shared presets. Each rule names the directive it enforces through `directive` in `policy/registries/rules.yaml`. The IDs come from the dotfiles enforcement map (`docs/enforcement-map.md` in the dotfiles repo): G directives from `ai-contexts/AGENT.md`, S directives from the cloud-rl-train process smells.

| Rule                                   | Directive | Runtime | Default                                   |
| -------------------------------------- | --------- | ------- | ----------------------------------------- |
| `antidrift/no-pass-through-parameters` | G22       | ESLint  | error, ratcheted by suppressions          |
| `antidrift/no-vague-names`             | G21       | ESLint  | error, ratcheted by suppressions          |
| `antidrift/no-compat-names`            | G5        | ESLint  | error, ratcheted by suppressions          |
| `antidrift/no-fallback-to-empty`       | G7        | Oxlint  | error                                     |
| `no-nested-ternary` (native)           | G8        | Oxlint  | owned by `@joedeleeuw/typescript-tooling` |
| `antidrift/no-else-if-chain`           | G9        | Oxlint  | error                                     |
| `antidrift/no-hash-literal`            | S1        | Oxlint  | error                                     |
| `antidrift/no-host-path-literal`       | S4        | Oxlint  | error                                     |
| `antidrift/no-dated-comments`          | S5        | Oxlint  | error                                     |

## Runtime choice

All nine rules need only AST and scope data, which by the engine decision in `docs/rule-authoring.md` makes them Oxlint rules. G21, G22 and G5 still run in the ESLint pass because they have large existing debt and Oxlint has no baseline. ESLint's bulk suppressions (`eslint-suppressions.json`) are the ratchet: existing violations are pinned per file and rule, a new violation fails, and fixed violations must be pruned. The ESLint pass covers TypeScript through the typed block and JavaScript through a parser-only block that enables just these three rules.

Consumer adoption is one step: run

```sh
eslint . --suppress-rule antidrift/no-vague-names --suppress-rule antidrift/no-pass-through-parameters --suppress-rule antidrift/no-compat-names
```

once and commit `eslint-suppressions.json`. After fixing violations, run `eslint . --prune-suppressions` so the count only goes down. `eslint-suppressions.json` is a protected policy file: changing it needs `POLICY_CHANGE=1` or a policy-source edit, so new debt cannot be suppressed quietly.

## G22 pass-through parameters

A parameter or destructured prop of a named function, method or component is reported when every runtime reference forwards it to another first-party layer and none reads it. Forwarding is a call argument (direct, spread, or shorthand property of an object literal argument), a JSX attribute value `prop={prop}`, or a JSX spread `{...rest}`. A destructured `...rest` that is only spread counts. Ousterhout's pass-through variable (_A Philosophy of Software Design_, section 7.5) is the cited red flag.

Narrowed on corpus evidence, keeping the intent of a layer carrying a value it does not use:

- The callee must be a first-party layer: a function, class or component declared in the module, an import through a relative or root-alias path (`./`, `../`, `@/`, `~/`, `#/`), a namespace import of one, or a `this.method`. Library calls, globals and intrinsic JSX elements consume the value.
- A forwarding call must be discarded or returned (also through `await`). When the function uses the call's result, it reads the value through a helper.
- Anonymous callbacks and functions in options objects passed to a call (`useMutation({ mutationFn })`, `Effect.tryPromise({ catch })`) have signatures owned by the caller and are skipped.

Corpus: 36 deduplicated TypeScript repositories on sushi (`~/code`, 14,282 parsed files, 2.54M lines; Chaski clones and worktrees removed, Chaski kept as current-state signal only). The literal definition reported 36,525 hits; the narrowed rule reports 3,807 across 26 repositories (Chaski 443). Ten sampled hits, all valid: `queryParams` forwarded to a route builder (chaski `url.ts`), `cause` forwarded by an override (executor `session-durable-object.ts`, valid though the signature is inherited), `message` forwarded by `fail` (homer `terminal-proxy.ts`), the `onCreated` callback prop (homer), `descending` (opencode `id.ts`), `options` to the init handler (sudocode), the props `stickyTopOffset` (chaski), `open` to `Dialog` (sudocode), `isSubmit` (chatbiz) and `disabled` (sudocode `issue-selector.tsx`).

## G21 vague names

Declared bindings (variables, destructured bindings, parameters, catch parameters, function and class names) are reported when the name is one of the vague nouns `data info value val obj thing stuff temp tmp foo bar baz res ret retval misc` (optionally followed by digits), an eslint-plugin-unicorn `prevent-abbreviations` default replacement key, a single letter other than `i j k n x y _`, a `Value|Data|Info|Obj|Object|Thing|Stuff` suffix, or a `my|the|some|temp|tmp` prefix. Imports, property keys and type names are not checked.

Narrowings: the first `props` parameter of a component or JSX-returning function is React's defined role; `formData` and `imageData` name platform instances; `tempDir`, `tmpFile` and similar name temporary filesystem entries. `e`, `ctx`, `value` and single letters stay reported. The categories follow the dotfiles G21 lane brief; port its final list when `config/code-health/rules/g21-vague-name.yml` lands.

Corpus: 41,390 hits in 35 repositories (43,169 before narrowing; the `props` exemption removed about 1,780). Ten sampled hits, all valid: `res` as a Promise resolver, `s` in a find callback, `e` in an error handler and a change handler, `opts`, `db`, `hunkData`, `ext` naming an external-directory item and an extension service, and `msg`.

## G5 compatibility names

Declared names matching `legacy|compat|deprecated|retire|no_?longer` in the declaration contexts of dotfiles `g5-compat-identifier.yml`: function declarations, variable declarators, parameters, classes, interfaces, type aliases, methods, property signatures and class fields. `compatible` is excluded, because an OpenAI-compatible protocol is a shape rather than a compatibility path.

Corpus: 385 hits in 13 repositories (446 before excluding `compatible`). Ten sampled hits, all valid: antidrift's `checkRetiredRules` and `lockedRetiredRules`, opencode `insertLegacyAssistantMessage`, `legacy` parameters in executor, homer and opencode, executor `readLegacyJournalTags` and `legacySources`, pi-smart-compact `legacyPath`, and opencode `legacySessionHref`.

Antidrift's own six hits all name the `retiredRules` ledger. A permanent ledger of withdrawn rules is a codified removal under G16. They are pinned in the suppressions file as G16 debt pending a decision on the ledger.

## G7 fallback to empty

Promotes `errors/no-fallback-to-empty` from research. A `return []` or `return {}` inside a catch clause, or a `.catch` handler whose body is `[]` or `{}`, is reported when the failure path drops the error: the caught error is never referenced and the handler never rethrows. A catch that checks `error.code === "ENOENT"` and rethrows everything else keeps empty as an explicit contract and stays clean.

Corpus: 115 hits for any empty return in a catch; 77 in 12 repositories after requiring a silent handler. Ten sampled hits, all valid silent fallbacks: four `.catch(() => [])` chains in opencode and executor, `readdir(...).catch(() => [])`, and catch blocks returning `{}` or `[]` in executor `planner.ts`, opencode `otlp.ts`, `editor.ts` and `tool-schema.ts`, and chatbiz `grading-system.js`.

## G8 nested ternaries

Native `no-nested-ternary` matches the directive exactly, so no custom rule exists. Since 0.15, generic native rules belong to `@joedeleeuw/typescript-tooling`, which carries it in its adoption preset; this repository's root Oxlint config enables it. The governance preset does not.

## G9 else-if chains

An if/else-if chain of four or more branches whose tests are `===`/`==` comparisons, or `||` of them, against one shared non-literal discriminant. Four branches matches the dotfiles threshold of an if plus three elifs.

Corpus: 29 hits in 11 repositories. Ten sampled hits, all valid: a seven-branch `fieldKey` chain (chatbiz), key handling over `event.key` (codiff, pierre), status chains over `consultation.status` (chatbiz, twice), an eight-branch focus chain over `currentRef` (charging-monitor), `row.type` rendering (hunk), a character scanner over `current` (executor), a CLI `command` dispatcher (executor) and a page dispatcher over `pageId` (chaski).

## S1 hash literals

A 64-hex string literal bound to a name containing `hash`, `sha`, `digest`, `checksum` or `integrity` through a variable, property, class field, assignment or comparison.

Corpus: 8 bare 64-hex literals; 3 after requiring a hash name, all valid and all in homer: `patchSha256` pins a repo-tracked patch file, `sourceSha256` pins an upstream tarball and `sha256` pins a fetched price table. The five dropped were two test vectors, two test encryption keys and an OAuth client ID.

## S4 host paths

A string or template literal starting with `/home/<user>/` or `/Users/<user>/`, outside test files. `/home/linuxbrew/` is the Homebrew prefix, not a user home.

Corpus: 165 hits; 157 were test fixtures such as `/Users/alex/repos/project`. After the narrowing, 6 hits remain, all reviewed: opencode `drizzle.config.ts` and `trace-imports.ts` hard-code a developer's home (valid); four executor e2e constants name paths inside a guest VM image (invalid: they do not couple to a developer host).

## S5 dated comments

The dotfiles `s5-dated-comment.yml` date pattern, skipping comments containing `@example` or a code fence. Two narrowings: a comment trailing code on the same line annotates data, and a date followed by a time of day is a timestamp format example.

Corpus: 41 hits; 26 after narrowing, in 5 repositories. All 26 were reviewed: 21 valid provenance notes ("Verified live 2026-08-14", "the 2026-04-16 prod outage", "Approved by Rhys 2026-07-08") and 5 invalid: three citations of the dated MCP Authorization 2025-06-18 specification, one example range in chatbiz-docs, and one regulation effective date.

## Validation

Rule behaviour is covered by `test/portable-cases.mjs` for the Oxlint rules and `src/eslint-plugin/naming-rules.test.mjs` for the ESLint rules. Corpus scans were read-only and ran on sushi from `/tmp`.
