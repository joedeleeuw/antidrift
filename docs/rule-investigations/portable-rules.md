# Portable guardrails in 0.11.0

## Status

Moved. antidrift no longer ships these rules. `@joedeleeuw/typescript-tooling` runs the stella rules as `tooling/<name>` and the Rika Labs rules from the published `@rikalabs/oxlint-standards` package as `rikalabs/<name>`. `antidrift/no-as-never` is retired; `typescript/no-unsafe-type-assertion` reports its cases. The record below describes the rules as antidrift shipped them.

51 new custom rules ship at error severity in the governance configuration. The plugin registers 80 rules in total. Eleven provisional rules are withdrawn; none ship as disabled implementations. The existing typed no-unsafe-deserialize owns parsed-JSON domain assignments, including the real private-app case.

The review below was run against a checkout of a private app. Its source files and sampled excerpts are not kept in this repository; each rule's tests are its valid and invalid cases and the packed consumer check.

Source attribution, per-module upstream digests, modified-file records and the verified upstream NOTICE were in antidrift's NOTICE, which moved to typescript-tooling with the code. Source labels below refer to those records.

| Rule                                             | Source          | Repair                                                                                                                       | Tests / private app after                                      |
| ------------------------------------------------ | --------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `antidrift/confine-owner`                        | Apache upstream | Typed entry item schema and configurable registry path and owners                                                            | Valid + invalid + packed; 0 hits (no positive corpus evidence) |
| `antidrift/docs-source-policy`                   | Apache upstream | Validate only the single configured policyFile; default docs-sources.mjs; derive dependencies from the real package manifest | Valid + invalid + packed; 0 hits (no positive corpus evidence) |
| `antidrift/icon-button-requires-tooltip`         | Apache upstream | Configurable iconComponents; remove product branding                                                                         | Valid + invalid + packed; 0 hits (no positive corpus evidence) |
| `antidrift/no-adhoc-loader`                      | Apache upstream | Configurable loaderIcons, owner and skeleton; portable HTML progress default                                                 | Valid + invalid + packed; 0 hits (no positive corpus evidence) |
| `antidrift/no-ai-debt-comments`                  | MIT upstream    | Declared options, plugin registration, valid/invalid regression and packed artifact proof                                    | Valid + invalid + packed; 0 hits (no positive corpus evidence) |
| `antidrift/no-ambient-hotkey-format`             | Apache upstream | Declared options, plugin registration, valid/invalid regression and packed artifact proof                                    | Valid + invalid + packed; 0 hits (no positive corpus evidence) |
| `antidrift/no-anemic-errors`                     | MIT upstream    | Accept contextual errors; detect Error calls with or without new; do not prescribe a fictional error class                   | Valid + invalid + packed; 0 hits (no positive corpus evidence) |
| `antidrift/no-as-never`                          | MIT upstream    | Declared options, plugin registration, valid/invalid regression and packed artifact proof                                    | Valid + invalid + packed; 1 hits                               |
| `antidrift/no-async-context-enter-with`          | Apache upstream | Declared options, plugin registration, valid/invalid regression and packed artifact proof                                    | Valid + invalid + packed; 0 hits (no positive corpus evidence) |
| `antidrift/no-auth-token-in-web-storage`         | Apache upstream | Declared options, plugin registration, valid/invalid regression and packed artifact proof                                    | Valid + invalid + packed; 0 hits (no positive corpus evidence) |
| `antidrift/no-awaited-builder-union`             | Apache upstream | Declared options, plugin registration, valid/invalid regression and packed artifact proof                                    | Valid + invalid + packed; 0 hits (no positive corpus evidence) |
| `antidrift/no-bun-api-in-shared`                 | MIT upstream    | Declared options, plugin registration, valid/invalid regression and packed artifact proof                                    | Valid + invalid + packed; 0 hits (no positive corpus evidence) |
| `antidrift/no-centered-scroll-column`            | Apache upstream | Check actual class values, not source-code strings                                                                           | Valid + invalid + packed; 0 hits (no positive corpus evidence) |
| `antidrift/no-debug-residue-filenames`           | MIT upstream    | Declared options, plugin registration, valid/invalid regression and packed artifact proof                                    | Valid + invalid + packed; 0 hits (no positive corpus evidence) |
| `antidrift/no-default-export-in-domain`          | MIT upstream    | Declared options, plugin registration, valid/invalid regression and packed artifact proof                                    | Valid + invalid + packed; 0 hits (no positive corpus evidence) |
| `antidrift/no-dialog-trigger-menu-item`          | Apache upstream | Declared options, plugin registration, valid/invalid regression and packed artifact proof                                    | Valid + invalid + packed; 0 hits (no positive corpus evidence) |
| `antidrift/no-disabled-tooltip-trigger`          | Apache upstream | Declared options, plugin registration, valid/invalid regression and packed artifact proof                                    | Valid + invalid + packed; 0 hits (no positive corpus evidence) |
| `antidrift/no-duplicate-context`                 | MIT upstream    | Declared options, plugin registration, valid/invalid regression and packed artifact proof                                    | Valid + invalid + packed; 0 hits (no positive corpus evidence) |
| `antidrift/no-eager-singleton`                   | Apache upstream | Declared options, plugin registration, valid/invalid regression and packed artifact proof                                    | Valid + invalid + packed; 0 hits (no positive corpus evidence) |
| `antidrift/no-generic-module-names`              | MIT upstream    | Declared options, plugin registration, valid/invalid regression and packed artifact proof                                    | Valid + invalid + packed; 1 hits                               |
| `antidrift/no-inline-style-colors`               | Apache upstream | Use declared palette/embedding scope; terminal black surface is a recorded platform boundary                                 | Valid + invalid + packed; 12 hits                              |
| `antidrift/no-omitted-prop-respread`             | Apache upstream | Declared options, plugin registration, valid/invalid regression and packed artifact proof                                    | Valid + invalid + packed; 0 hits (no positive corpus evidence) |
| `antidrift/no-partial-record-satisfies`          | Apache upstream | Declared options, plugin registration, valid/invalid regression and packed artifact proof                                    | Valid + invalid + packed; 0 hits (no positive corpus evidence) |
| `antidrift/no-path-prefix-containment`           | Apache upstream | Declared options, plugin registration, valid/invalid regression and packed artifact proof                                    | Valid + invalid + packed; 0 hits (no positive corpus evidence) |
| `antidrift/no-physical-properties`               | Apache upstream | Check actual class values, not source-code strings; preserve symmetric insets                                                | Valid + invalid + packed; 34 hits                              |
| `antidrift/no-placeholder-tests`                 | MIT upstream    | Declared options, plugin registration, valid/invalid regression and packed artifact proof                                    | Valid + invalid + packed; 0 hits (no positive corpus evidence) |
| `antidrift/no-portal-under-interactive-ancestor` | Apache upstream | Declared options, plugin registration, valid/invalid regression and packed artifact proof                                    | Valid + invalid + packed; 0 hits (no positive corpus evidence) |
| `antidrift/no-raw-filename-write`                | Apache upstream | Declared options, plugin registration, valid/invalid regression and packed artifact proof                                    | Valid + invalid + packed; 0 hits (no positive corpus evidence) |
| `antidrift/no-raw-foreground-opacity`            | Apache upstream | Declared options, plugin registration, valid/invalid regression and packed artifact proof                                    | Valid + invalid + packed; 0 hits (no positive corpus evidence) |
| `antidrift/no-redacted-log-attribute-key`        | Apache upstream | Declared options, plugin registration, valid/invalid regression and packed artifact proof                                    | Valid + invalid + packed; 0 hits (no positive corpus evidence) |
| `antidrift/no-relative-cross-package-imports`    | MIT upstream    | Resolve actual package boundaries and preserve ancestor configuration owners                                                 | Valid + invalid + packed; 8 hits                               |
| `antidrift/no-spread-input-in-query-key`         | Apache upstream | Declared options, plugin registration, valid/invalid regression and packed artifact proof                                    | Valid + invalid + packed; 0 hits (no positive corpus evidence) |
| `antidrift/no-static-devtools-import`            | Apache upstream | Declared options, plugin registration, valid/invalid regression and packed artifact proof                                    | Valid + invalid + packed; 0 hits (no positive corpus evidence) |
| `antidrift/no-todo-without-issue`                | MIT upstream    | Declared options, plugin registration, valid/invalid regression and packed artifact proof                                    | Valid + invalid + packed; 3 hits                               |
| `antidrift/no-trivial-property-helpers`          | MIT upstream    | Require the helper declaration and property/fallback body; names at unrelated call sites are not proof                       | Valid + invalid + packed; 0 hits (no positive corpus evidence) |
| `antidrift/no-tutorial-comments`                 | MIT upstream    | Declared options, plugin registration, valid/invalid regression and packed artifact proof                                    | Valid + invalid + packed; 0 hits (no positive corpus evidence) |
| `antidrift/no-unformatted-number`                | Apache upstream | Configurable formatter; Intl.NumberFormat default; raw state in test output is not display text                              | Valid + invalid + packed; 7 hits                               |
| `antidrift/no-unlisted-external-imports`         | MIT upstream    | Skip marker manifests; honor ancestor devDependencies; sibling packages do not grant dependencies                            | Valid + invalid + packed; 0 hits (no positive corpus evidence) |
| `antidrift/no-unsafe-inner-html`                 | Apache upstream | Imported sanitizer and trusted-source registry; resolve aliases and shadowing; remove comment bypass                         | Valid + invalid + packed; 0 hits (no positive corpus evidence) |
| `antidrift/no-unsanitized-href`                  | Apache upstream | Imported sanitizer binding resolution; reject local identity functions; exact http(s) protocol prefixes                      | Valid + invalid + packed; 0 hits (no positive corpus evidence) |
| `antidrift/require-detached-label-shape`         | Apache upstream | Declared options, plugin registration, valid/invalid regression and packed artifact proof                                    | Valid + invalid + packed; 0 hits (no positive corpus evidence) |
| `antidrift/require-dir-on-rendered-name`         | Apache upstream | Configurable nameProps, isolatingComponents and owner; accept native bdi; portable Unicode FSI/PDI default                   | Valid + invalid + packed; 3 hits                               |
| `antidrift/require-exhaustive-panic`             | Apache upstream | Declared options, plugin registration, valid/invalid regression and packed artifact proof                                    | Valid + invalid + packed; 3 hits                               |
| `antidrift/require-fetch-timeout`                | Apache upstream | Follow immutable fetch aliases and typeof fetch/default parameters; preserve real network smoke findings                     | Valid + invalid + packed; 22 hits                              |
| `antidrift/require-function-replacer`            | Apache upstream | Accept constant String.raw replacements; dynamic strings still require a callback                                            | Valid + invalid + packed; 15 hits                              |
| `antidrift/require-query-key-factory`            | Apache upstream | A shared immutable local key is already an owner; independent inline arrays still report                                     | Valid + invalid + packed; 11 hits                              |
| `antidrift/require-query-signal`                 | Apache upstream | Declared options, plugin registration, valid/invalid regression and packed artifact proof                                    | Valid + invalid + packed; 0 hits (no positive corpus evidence) |
| `antidrift/require-safe-window-open`             | Apache upstream | Accept the compile-valid browser API with noopener,noreferrer; distinguish the explicit popup-policy probe                   | Valid + invalid + packed; 1 hits                               |
| `antidrift/require-secure-document-response`     | Apache upstream | Remove dead IIFE; accept explicit secure Response headers; configurable response owner                                       | Valid + invalid + packed; 0 hits (no positive corpus evidence) |
| `antidrift/require-stable-snapshot`              | Apache upstream | Declared options, plugin registration, valid/invalid regression and packed artifact proof                                    | Valid + invalid + packed; 0 hits (no positive corpus evidence) |
| `antidrift/require-stream-reader-disposal`       | Apache upstream | Declared options, plugin registration, valid/invalid regression and packed artifact proof                                    | Valid + invalid + packed; 4 hits                               |

## Per-rule agent-intent review

The table records each rule's before and after counts and its decision. Counts measure violations, not precision. The fixed black terminal surface, popup-policy probe and installed-fetch-double test had explicit, reviewed owner scopes. Production files and network smoke tests remain loud.

| Rule                                   | Before |     After | Decision |
| -------------------------------------- | -----: | --------: | -------- |
| `no-bun-api-in-shared`                 |      0 |         0 | fix      |
| `no-duplicate-context`                 |      0 |         0 | fix      |
| `no-ai-debt-comments`                  |      0 |         0 | fix      |
| `no-json-parse-default-fallback`       |     18 | withdrawn | withdraw |
| `no-json-stringify-default-fallback`   |      5 | withdrawn | withdraw |
| `no-as-never`                          |      1 |         1 | fix      |
| `no-todo-without-issue`                |      3 |         3 | fix      |
| `no-generic-module-names`              |      1 |         1 | fix      |
| `no-default-export-in-domain`          |      0 |         0 | fix      |
| `no-anemic-errors`                     |      0 |         0 | fix      |
| `no-relative-cross-package-imports`    |     11 |         8 | fix      |
| `no-trivial-property-helpers`          |      0 |         0 | fix      |
| `no-single-use-trivial-helpers`        |    306 | withdrawn | withdraw |
| `no-tutorial-comments`                 |      0 |         0 | fix      |
| `no-debug-residue-filenames`           |      0 |         0 | fix      |
| `no-placeholder-tests`                 |      0 |         0 | fix      |
| `confine-owner`                        |      0 |         0 | fix      |
| `docs-source-policy`                   |    975 |         0 | fix      |
| `forbid-dev-runner-config-reads`       |     40 | withdrawn | withdraw |
| `forbid-process-env-outside-env-ts`    |    104 | withdrawn | withdraw |
| `icon-button-requires-tooltip`         |      0 |         0 | fix      |
| `no-adhoc-loader`                      |      0 |         0 | fix      |
| `no-ambient-hotkey-format`             |      0 |         0 | fix      |
| `no-ambient-nondeterminism`            |    179 | withdrawn | withdraw |
| `no-async-context-enter-with`          |      0 |         0 | fix      |
| `no-auth-token-in-web-storage`         |      0 |         0 | fix      |
| `no-awaited-builder-union`             |      0 |         0 | fix      |
| `no-bare-error`                        |   1028 | withdrawn | withdraw |
| `no-centered-scroll-column`            |      0 |         0 | fix      |
| `no-dialog-trigger-menu-item`          |      0 |         0 | fix      |
| `no-disabled-tooltip-trigger`          |      0 |         0 | fix      |
| `no-eager-singleton`                   |      0 |         0 | fix      |
| `no-inline-style-colors`               |     13 |        12 | fix      |
| `no-omitted-prop-respread`             |      0 |         0 | fix      |
| `no-partial-record-satisfies`          |      0 |         0 | fix      |
| `no-path-prefix-containment`           |      0 |         0 | fix      |
| `no-physical-properties`               |     37 |        34 | fix      |
| `no-raw-foreground-opacity`            |      0 |         0 | fix      |
| `no-raw-locale-format`                 |      2 | withdrawn | withdraw |
| `no-redacted-log-attribute-key`        |      0 |         0 | fix      |
| `no-ref-mirror`                        |      6 | withdrawn | withdraw |
| `no-spread-input-in-query-key`         |      0 |         0 | fix      |
| `no-static-devtools-import`            |      0 |         0 | fix      |
| `no-swallowed-rejection`               |     29 | withdrawn | withdraw |
| `no-unformatted-number`                |      8 |         7 | fix      |
| `no-unsafe-inner-html`                 |      0 |         0 | fix      |
| `no-portal-under-interactive-ancestor` |      0 |         0 | fix      |
| `require-detached-label-shape`         |      0 |         0 | fix      |
| `require-dir-on-rendered-name`         |      3 |         3 | fix      |
| `require-exhaustive-panic`             |      3 |         3 | fix      |
| `require-fetch-timeout`                |     25 |        22 | fix      |
| `require-function-replacer`            |     15 |        15 | fix      |
| `require-query-key-factory`            |     12 |        11 | fix      |
| `require-query-signal`                 |      0 |         0 | fix      |
| `require-safe-outbound-target`         |     43 | withdrawn | withdraw |
| `require-safe-window-open`             |      2 |         1 | fix      |
| `require-stable-snapshot`              |      0 |         0 | fix      |
| `require-stream-reader-disposal`       |      4 |         4 | fix      |
| `no-raw-filename-write`                |      0 |         0 | fix      |
| `no-unsanitized-href`                  |      0 |         0 | fix      |
| `require-secure-document-response`     |      0 |         0 | fix      |
| `no-unlisted-external-imports`         |    230 |         0 | fix      |

## Withdrawals

- `no-json-parse-default-fallback`: Subject defect: 4/5 samples are explicit invalid-input or discovery outcomes, not fabricated successful domain data. The syntax detector cannot establish that semantic distinction.
- `no-json-stringify-default-fallback`: Subject defect: 4/5 samples catch network or stream failures, not serialization failures. Keeping only coalescing syntax would leave the promised catch detector unresolved.
- `no-single-use-trivial-helpers`: Attempted repairs excluded predicates, imported return contracts, entrypoints and nested work (306 -> 239), but the remaining detector still mistakes the private app's timestamp-validation boundary and Linux NUL-separated process decoding for caller-owned work. Reference counts plus size cannot prove portable ownership. Keep arch/no-one-use-helper in research; genuine one-use drift remains unsolved, not silenced in a disabled shipped rule.
- `forbid-dev-runner-config-reads`: 4/5 samples are the actual CLI or build owner. The remaining launch drift has no existing runner configuration owner this diagnostic can name. A filename convention cannot prove that boundary.
- `forbid-process-env-outside-env-ts`: 4/5 samples already own runtime or build environment handling or merely forward it. An env.ts basename is not a portable ownership contract.
- `no-ambient-nondeterminism`: 5/5 samples own clocks, entropy or elapsed-time measurement. The detector cannot determine that a module is deterministic from an ambient API call.
- `no-bare-error`: 4/5 sampled throws are actionable failures at their real owners; the remaining RPC flattening is drift, but the prescribed operational error owner does not exist. Cause-bearing throws and test boundaries also violate the promised subject. Existing caught-error rules remain the causal-evidence owner.
- `no-raw-locale-format`: 2/2 hits belong to the English time-tool response contract. No separate user-locale owner exists at either hit.
- `no-ref-mirror`: 3/5 hits are transition history or completion receipts, not redundant state. The two signal hits require different callback contracts; the prescribed effect-event edit is not valid for arbitrary callbacks.
- `no-swallowed-rejection`: 3/5 hits are sequencing or cleanup whose primary failure is owned elsewhere; local catch syntax cannot prove fabricated success.
- `require-safe-outbound-target`: 5/5 samples have selected runtime/test endpoints or fetch doubles. No trust-provenance check establishes that the target is unsafe; the configured fictional sanitizer is not an owner.

The helper review changed the original blanket false-positive classification: eleven of twenty original samples are agent-drift signal. Predicate, nested-work and entrypoint repairs were attempted (306 to 239 in the exploratory run), but remaining platform-boundary counterexamples keep `arch/no-one-use-helper` in research. Names alone do not justify a false-positive judgement.

## Native composition

The adoption export composes 436 native In rule IDs in eleven named, opt-in presets, excluding eighteen Next entries. The source selection is regenerated from the original adoption data; the reviewer’s 433 count omitted the three existing complexity settings. Those three retain their existing budgets. Native style findings are policy-conformance findings, not claims of runtime defects.

## Limits

These portable checks use syntax and local bindings. Typed fetch detection recognizes typeof fetch annotations and default parameters; it does not claim arbitrary cross-file TypeScript type inference. The typed deserialization rule uses the TypeScript checker. Zero-hit rules are preventive and carry no positive-corpus precision claim. No out-of-scope application pack is copied.

## Off by default by owner decision (October 2026)

Six portable rules now ship `off` in the governance configuration. On 20 fresh reports per rule from BuilderIO/agent-native, cloudflare/agents, LibreChat and opencode, each judged by whether a reviewer would ask for the change, under half were real problems. Each rule stays in the plugin for projects that enable it explicitly.

| Rule                                     | Real | What the other reports were                                                                      |
| ---------------------------------------- | ---: | ------------------------------------------------------------------------------------------------ |
| `antidrift/no-as-never`                  | 6/20 | 19 of the 20 were in tests, where partial doubles and deliberately invalid inputs dominate       |
| `antidrift/no-physical-properties`       | 9/20 | 9 of 13 were real in apps that ship right-to-left locales; 0 of 7 in English-only code           |
| `antidrift/no-raw-foreground-opacity`    | 0/20 | the app defines none of the token names the message suggests                                     |
| `antidrift/no-unlisted-external-imports` | 6/20 | type imports covered by a listed `@types` package, tsconfig path aliases, root tooling and bun   |
| `antidrift/require-fetch-timeout`        | 5/20 | 11 were tests calling a server the test started; 5 of 8 outside tests were real                  |
| `antidrift/require-query-key-factory`    | 4/20 | tests seeding the cache, prefix invalidations and short keys repeated nearby, with no key helper |
