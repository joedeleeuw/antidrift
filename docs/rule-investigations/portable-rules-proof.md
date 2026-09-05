# AP1b release proof

Version: 0.11.0. The corrected worktree passes the release gates. The original commit cannot yet be rewritten because the managed sandbox denies writes to the parent repository Git directory. No push or publication occurred.

| Command                                                                   | Exit | Result                                                                               |
| ------------------------------------------------------------------------- | ---: | ------------------------------------------------------------------------------------ |
| `pnpm verify:release`                                                     |    0 | All policy, type, lint, unit and packed consumer checks passed                       |
| `pnpm policy:verify-session`                                              |    0 | Required session gate passed                                                         |
| `pnpm package:verify`                                                     |    0 | Every new custom rule and native preset category fired from the packed package       |
| `pnpm pack`                                                               |    0 | Tarball created from tooling/antidrift                                               |
| `tar tzf joedeleeuw-antidrift-0.11.0.tgz`                                 |    0 | Complete file list below; tarball then deleted                                       |
| `node tooling/antidrift/test/reproduce-homer.mjs /Users/sushi/code/homer` |    0 | Reproduced every final custom count, native inventory and compiling JSON remediation |
| `git diff --check`                                                        |    0 | No whitespace errors                                                                 |
| `git add -A`                                                              |  128 | Cannot create the parent worktree index.lock                                         |

Source snapshots, tarballs, failed consumer workspaces and task scratch were deleted. The pre-existing offline dependency caches remain available for repeating the gates.

The offline gate environment was:

```sh
ANTIDRIFT_CONSUMER_OFFLINE=1
ANTIDRIFT_CONSUMER_PNPM=/Users/sushi/.cache/node/corepack/v1/pnpm/10.33.4/bin/pnpm.cjs
npm_config_store_dir=/tmp/ap1-pnpm-store
npm_config_cache_dir=/tmp/ap1-pnpm-cache
```

Release tail:

```text
+ typescript-eslint 8.60.1

Done in 538ms using pnpm v10.33.4
4/7  linting consumer files through shipped and opt-in configs ...
     portable rules: 51 packed rules each report one finding; licenses included
     native adoption: 436 error rules; every named preset reports through the packed export
5/7  reading the shipped semantic adapter manifest from the CLI ...
6/7  typechecking every public export under supported TS resolution modes ...
7/7  importing every public runtime export ...

✓ tarball installs, type-checks, imports, and enforces in a consumer monorepo
  focused governance rejected oversized root, Convex, script, fixture, test, and undeclared generated-looking modules while ignoring registry-declared generated code, declarations, and raw JSON; consumer precedence disabled max-lines, the default typed config loaded registry owners and fired antidrift/no-structural-type-fork on drift.ts, the inventory config checked a TypeScript 6 broad-input predicate, async-array shipped behavior matched default and opt-in branch expectations, a structuralMatch fact was emitted, and clean.ts/package-copy.ts stayed clean; public exports and semantic adapters passed Bundler and NodeNext.
```

## Counts and corpus

Registered Oxlint rules: main 29; original 01874458 91; corrected worktree 80. New ports retained: 51. Withdrawn: 11. Native adoption: 436 rule IDs, excluding eighteen Next entries. The corpus contains 98 complete files authenticated by the pinned Git commit and 57 tree objects.

Final custom findings: 125. No retained custom rule exceeds fifty findings. Native findings: 16194; every native rule above fifty has three sampled policy classifications. See [the rule table](portable-rules.md), [custom review](../../tooling/antidrift/test/corpus/homer-review.json), and [native review](../../tooling/antidrift/test/corpus/native-review.json).

The live read-only checkout advanced from dc7d554d to bb602e14 during work. The final before/after comparison therefore uses an archive extracted directly from the real local Git history at dc7d554d. No Homer source files or Git refs were changed. The committed reproduction command performs this extraction itself and deletes it afterward. The three reviewed platform/test ownership scopes are explicit in the custom report; ordinary production findings remain errors.

The real tools.ts:1439 remediation uses the already-imported z.record(z.string(), z.string()) validator. TypeScript errors were 0 before and 0 after; the diagnostic changed from 1 to 0. The full-file regression and reproduction command both pin that result.

## Attribution

The verified upstream NOTICE is reproduced in full in the package NOTICE, with the repository and pinned revision. Every retained port differs from the supplied pinned TypeScript source and is marked MODIFIED with its source digest. The complete supplied Apache LICENSE, including appendix, is byte-identical to licenses/Apache-2.0.txt.

- Upstream NOTICE SHA-256: `edc53a95c672f73720bdcdbd1db8b6aec58c968cfb0fb668136b67eb773a6a5b`
- Upstream LICENSE SHA-256: `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`

## Git blocker

```text
fatal: Unable to create '/Users/sushi/code/agent-guardrails-monorepo-template/.git/worktrees/agent-guardrails-monorepo-template.guardrails-portable-rules/index.lock': Operation not permitted
```

The supplied managed permission profile grants writes to the worktree, but not the parent Git directory. The original 01874458 is still HEAD, including its old trailer. The worktree is intentionally dirty with the requested corrections; a clean status and corrected single commit cannot be claimed until that permission is fixed.

The existing committed comparison, which does not include these corrections, is:

```text
git rev-list --count main..HEAD: 1
git diff --shortstat main..HEAD: 87 files changed, 14719 insertions(+), 33 deletions(-)
```

Pending worktree delta including new files: 100 files changed, 25384 insertions(+), 50 deletions(-)

## Rule directory listing

`ls tooling/antidrift/src/oxlint-plugin/rules` (exit 0):

```text
no-calling-components-as-functions.js
no-duplicated-conditional-classnames.js
no-duplicated-object-field-blocks.js
no-nonindependent-test-oracle.js
no-sentinel-absence-fallback.js
no-silent-empty-detection-fallback.js
no-static-property-loop.js
require-effect-deps.js
```

`ls tooling/antidrift/src/oxlint-plugin/anti-slop/rules` (exit 0):

```text
no-chained-type-assertions.js
no-conditional-empty-object-spread.js
no-known-value-widening.js
no-module-mocking.js
no-object-parameters.js
no-reflect-apply.js
no-reflect-get.js
no-runtime-typeof.js
no-shape-in-symbol-names.js
no-unknown-parameters.js
no-unknown-returns.js
no-unknown-type-aliases.js
no-unsafe-dictionary-type.js
no-widen-then-assert.js
require-safety-comment-for-type-assertion.js
```

`ls tooling/antidrift/src/oxlint-plugin/anti-slop/effect/rules` (exit 0):

```text
no-service-constructor-imports.js
```

`ls tooling/antidrift/src/oxlint-plugin/portable` (exit 0):

```text
ast.js
class-value.js
confine-owner.js
dependency-owner.test.mjs
docs-source-policy.js
fixtures
homer-corpus.test.mjs
icon-button-requires-tooltip.js
imported-owner.js
no-adhoc-loader.js
no-ai-debt-comments.js
no-ambient-hotkey-format.js
no-anemic-errors.js
no-as-never.js
no-async-context-enter-with.js
no-auth-token-in-web-storage.js
no-awaited-builder-union.js
no-bun-api-in-shared.js
no-centered-scroll-column.js
no-debug-residue-filenames.js
no-default-export-in-domain.js
no-dialog-trigger-menu-item.js
no-disabled-tooltip-trigger.js
no-duplicate-context.js
no-eager-singleton.js
no-generic-module-names.js
no-inline-style-colors.js
no-omitted-prop-respread.js
no-partial-record-satisfies.js
no-path-prefix-containment.js
no-physical-properties.js
no-placeholder-tests.js
no-portal-under-interactive-ancestor.js
no-raw-filename-write.js
no-raw-foreground-opacity.js
no-redacted-log-attribute-key.js
no-relative-cross-package-imports.js
no-spread-input-in-query-key.js
no-static-devtools-import.js
no-todo-without-issue.js
no-trivial-property-helpers.js
no-tutorial-comments.js
no-unformatted-number.js
no-unlisted-external-imports.js
no-unsafe-inner-html.js
no-unsanitized-href.js
owner-repairs.test.mjs
package-owner.js
physical-properties.js
portable.test.mjs
require-detached-label-shape.js
require-dir-on-rendered-name.js
require-exhaustive-panic.js
require-fetch-timeout.js
require-function-replacer.js
require-query-key-factory.js
require-query-signal.js
require-safe-window-open.js
require-secure-document-response.js
require-stable-snapshot.js
require-stream-reader-disposal.js
scope.js
syntax.js
```

## Packed file list

```text
package/LICENSE
package/src/oxlint-plugin/anti-slop/LICENSE
package/NOTICE
package/src/oxlint-plugin/portable/ast.js
package/src/oxlint-plugin/portable/class-value.js
package/src/oxlint-plugin/portable/confine-owner.js
package/src/oxlint-plugin/anti-slop/shared/dictionary-types.js
package/src/oxlint-plugin/portable/docs-source-policy.js
package/src/oxlint-plugin/portable/icon-button-requires-tooltip.js
package/src/oxlint-plugin/portable/imported-owner.js
package/src/eslint-plugin/index.js
package/src/oxlint-plugin/index.js
package/src/oxlint-plugin/anti-slop/shared/lexical-type-parameters.js
package/src/oxlint-plugin/portable/no-adhoc-loader.js
package/src/oxlint-plugin/portable/no-ai-debt-comments.js
package/src/oxlint-plugin/portable/no-ambient-hotkey-format.js
package/src/oxlint-plugin/portable/no-anemic-errors.js
package/src/eslint-plugin/rules/no-appeasement-cast.js
package/src/eslint-plugin/rules/no-appeasement-erasure.js
package/src/oxlint-plugin/portable/no-as-never.js
package/src/oxlint-plugin/portable/no-async-context-enter-with.js
package/src/oxlint-plugin/portable/no-auth-token-in-web-storage.js
package/src/oxlint-plugin/portable/no-awaited-builder-union.js
package/src/oxlint-plugin/portable/no-bun-api-in-shared.js
package/src/oxlint-plugin/rules/no-calling-components-as-functions.js
package/src/eslint-plugin/rules/no-canonical-model-fork.js
package/src/oxlint-plugin/portable/no-centered-scroll-column.js
package/src/oxlint-plugin/anti-slop/rules/no-chained-type-assertions.js
package/src/oxlint-plugin/anti-slop/rules/no-conditional-empty-object-spread.js
package/src/eslint-plugin/rules/no-contract-appeasement-projection.js
package/src/oxlint-plugin/portable/no-debug-residue-filenames.js
package/src/oxlint-plugin/portable/no-default-export-in-domain.js
package/src/eslint-plugin/rules/no-defensive-shape-probing.js
package/src/oxlint-plugin/portable/no-dialog-trigger-menu-item.js
package/src/oxlint-plugin/portable/no-disabled-tooltip-trigger.js
package/src/oxlint-plugin/portable/no-duplicate-context.js
package/src/oxlint-plugin/rules/no-duplicated-conditional-classnames.js
package/src/oxlint-plugin/rules/no-duplicated-object-field-blocks.js
package/src/oxlint-plugin/portable/no-eager-singleton.js
package/src/eslint-plugin/rules/no-explicit-type-arguments-on-owned-api.js
package/src/oxlint-plugin/portable/no-generic-module-names.js
package/src/eslint-plugin/rules/no-identity-schema-transform.js
package/src/oxlint-plugin/portable/no-inline-style-colors.js
package/src/oxlint-plugin/anti-slop/rules/no-known-value-widening.js
package/src/oxlint-plugin/anti-slop/rules/no-module-mocking.js
package/src/oxlint-plugin/rules/no-nonindependent-test-oracle.js
package/src/eslint-plugin/rules/no-nullable-positional-tuple.js
package/src/oxlint-plugin/anti-slop/rules/no-object-parameters.js
package/src/oxlint-plugin/portable/no-omitted-prop-respread.js
package/src/eslint-plugin/rules/no-parse-as-cast.js
package/src/oxlint-plugin/portable/no-partial-record-satisfies.js
package/src/oxlint-plugin/portable/no-path-prefix-containment.js
package/src/oxlint-plugin/portable/no-physical-properties.js
package/src/oxlint-plugin/portable/no-placeholder-tests.js
package/src/oxlint-plugin/portable/no-portal-under-interactive-ancestor.js
package/src/oxlint-plugin/portable/no-raw-filename-write.js
package/src/oxlint-plugin/portable/no-raw-foreground-opacity.js
package/src/oxlint-plugin/portable/no-redacted-log-attribute-key.js
package/src/eslint-plugin/rules/no-redundant-zod-parse.js
package/src/oxlint-plugin/anti-slop/rules/no-reflect-apply.js
package/src/oxlint-plugin/anti-slop/rules/no-reflect-get.js
package/src/oxlint-plugin/portable/no-relative-cross-package-imports.js
package/src/oxlint-plugin/anti-slop/rules/no-runtime-typeof.js
package/src/eslint-plugin/rules/no-schema-validator-transcoding.js
package/src/oxlint-plugin/rules/no-sentinel-absence-fallback.js
package/src/oxlint-plugin/anti-slop/effect/rules/no-service-constructor-imports.js
package/src/oxlint-plugin/anti-slop/rules/no-shape-in-symbol-names.js
package/src/oxlint-plugin/rules/no-silent-empty-detection-fallback.js
package/src/oxlint-plugin/portable/no-spread-input-in-query-key.js
package/src/eslint-plugin/rules/no-sql-string-concat.js
package/src/oxlint-plugin/portable/no-static-devtools-import.js
package/src/oxlint-plugin/rules/no-static-property-loop.js
package/src/eslint-plugin/rules/no-structural-type-fork.js
package/src/oxlint-plugin/portable/no-todo-without-issue.js
package/src/oxlint-plugin/portable/no-trivial-property-helpers.js
package/src/oxlint-plugin/portable/no-tutorial-comments.js
package/src/eslint-plugin/rules/no-underchecked-type-predicate.js
package/src/oxlint-plugin/portable/no-unformatted-number.js
package/src/oxlint-plugin/anti-slop/rules/no-unknown-parameters.js
package/src/oxlint-plugin/anti-slop/rules/no-unknown-returns.js
package/src/oxlint-plugin/anti-slop/rules/no-unknown-type-aliases.js
package/src/oxlint-plugin/portable/no-unlisted-external-imports.js
package/src/eslint-plugin/rules/no-unsafe-deserialize.js
package/src/oxlint-plugin/anti-slop/rules/no-unsafe-dictionary-type.js
package/src/oxlint-plugin/portable/no-unsafe-inner-html.js
package/src/oxlint-plugin/portable/no-unsanitized-href.js
package/src/oxlint-plugin/anti-slop/rules/no-widen-then-assert.js
package/src/oxlint-plugin/portable/package-owner.js
package/src/oxlint-plugin/portable/physical-properties.js
package/src/eslint-plugin/rules/react-max-component-props.js
package/src/semantic-adapters/react-state-graph.js
package/src/oxlint-plugin/anti-slop/shared/reflect-method.js
package/src/eslint-plugin/rules/require-convex-return-validator.js
package/src/oxlint-plugin/portable/require-detached-label-shape.js
package/src/oxlint-plugin/portable/require-dir-on-rendered-name.js
package/src/oxlint-plugin/rules/require-effect-deps.js
package/src/oxlint-plugin/portable/require-exhaustive-panic.js
package/src/oxlint-plugin/portable/require-fetch-timeout.js
package/src/oxlint-plugin/portable/require-function-replacer.js
package/src/oxlint-plugin/portable/require-query-key-factory.js
package/src/oxlint-plugin/portable/require-query-signal.js
package/src/oxlint-plugin/portable/require-safe-window-open.js
package/src/oxlint-plugin/anti-slop/rules/require-safety-comment-for-type-assertion.js
package/src/oxlint-plugin/portable/require-secure-document-response.js
package/src/oxlint-plugin/portable/require-stable-snapshot.js
package/src/oxlint-plugin/portable/require-stream-reader-disposal.js
package/src/oxlint-plugin/portable/scope.js
package/src/eslint-plugin/rules/sql-syntax-analysis.js
package/src/eslint-plugin/rules/structural-fork-proof.js
package/src/oxlint-plugin/portable/syntax.js
package/src/eslint-plugin/rules/type-services.js
package/package.json
package/CHANGELOG.md
package/README.md
package/src/oxlint-config/adoption.mjs
package/src/change-scope/analyze.mjs
package/src/semantic-adapters/async-control-flow.mjs
package/src/semantic-adapters/auth-boundary.mjs
package/src/policy/hooks/block-generated-policy-edits.mjs
package/src/semantic-adapters/broad-input.mjs
package/src/policy/external-corpus/cases.mjs
package/src/change-scope/change-context.mjs
package/src/change-scope/change-contract-evidence.mjs
package/src/change-scope/change-contract.mjs
package/src/policy/chaski-corpus.mjs
package/src/policy/check-changed.mjs
package/src/policy/check-generated-policy-artifacts.mjs
package/src/policy/check-registries.mjs
package/src/policy/check-rule-surface.mjs
package/src/policy/cli.mjs
package/src/change-scope/contract-schema.mjs
package/src/policy/declaration-clone-inventory.mjs
package/src/policy/defensive-shape-inventory.mjs
package/src/change-scope/diff-scoped-adapters.mjs
package/src/policy/registry-checks/domain.mjs
package/src/semantic-adapters/effect-schema.mjs
package/src/policy/eslint-json-to-sonar.mjs
package/src/change-scope/exports.mjs
package/src/policy/external-corpus.mjs
package/src/policy/generate-policy-artifacts.mjs
package/src/policy/lib/generated-targets.mjs
package/src/policy/lib/git.mjs
package/src/brand/index.mjs
package/src/eslint-config/index.mjs
package/src/index.mjs
package/src/oxlint-config/index.mjs
package/src/policy/index.mjs
package/src/semantic-adapters/index.mjs
package/src/semantic-adapters/local-ast-rules.mjs
package/src/change-scope/module-graph.mjs
package/src/policy/no-appeasement-remediation-corpus.mjs
package/src/policy/oxlint.mjs
package/src/policy/registry-checks/package-surface.mjs
package/src/semantic-adapters/parse-input.mjs
package/src/semantic-adapters/parsed-json.mjs
package/src/policy/react-state-inventory.mjs
package/src/semantic-adapters/react-state.mjs
package/src/policy/lib/registries.mjs
package/src/policy/repo-corpus.mjs
package/src/policy/lib/rule-status.mjs
package/src/policy/registry-checks/rules.mjs
package/src/policy/external-corpus/runner.mjs
package/src/semantic-adapters/schema-provenance.mjs
package/src/policy/schema-roundtrip-inventory.mjs
package/src/policy/registry-checks/semantic-contracts.mjs
package/src/policy/lib/semantic-facts.mjs
package/src/policy/shell-guardrails.mjs
package/src/policy/sql-broad-inventory.mjs
package/src/policy/sql-query-benchmark.mjs
package/src/semantic-adapters/sql.mjs
package/src/semantic-adapters/status-literal.mjs
package/src/syntax-rules.mjs
package/src/semantic-adapters/tuple-shape.mjs
package/src/policy/lib/type-index.mjs
package/src/policy/type-owner-inventory.mjs
package/src/semantic-adapters/type-owner.mjs
package/src/policy/underchecked-predicate-inventory.mjs
package/src/policy/unsafe-type-assertion-benchmark.mjs
package/src/policy/hooks/verify-session-stop.mjs
package/src/policy/verify-session.mjs
package/src/oxlint-config/adoption.d.mts
package/src/semantic-adapters/async-control-flow.d.mts
package/src/semantic-adapters/auth-boundary.d.mts
package/src/semantic-adapters/broad-input.d.mts
package/src/brand/index.d.mts
package/src/eslint-config/index.d.mts
package/src/index.d.mts
package/src/oxlint-config/index.d.mts
package/src/policy/index.d.mts
package/src/semantic-adapters/index.d.mts
package/src/policy/external-corpus/oxlint.config.mts
package/src/semantic-adapters/parse-input.d.mts
package/src/semantic-adapters/react-state.d.mts
package/src/semantic-adapters/schema-provenance.d.mts
package/src/semantic-adapters/sql.d.mts
package/src/semantic-adapters/tuple-shape.d.mts
package/src/semantic-adapters/type-owner.d.mts
package/src/eslint-plugin/index.d.ts
package/src/oxlint-plugin/index.d.ts
package/licenses/Apache-2.0.txt
package/licenses/Rika-Labs-MIT.txt
package/ast-grep/rule-tests/no-swallowed-command-substitution-status-test.yml
package/ast-grep/rules/no-swallowed-command-substitution-status.yml
package/ast-grep/sgconfig.yml
```
