I've read all eight files. The `no-unsafe-deserialize` rule body is fully visible at `index.js:1050-1074` with its helpers at `index.js:924-1048`.

## 1. Implementation status vs. registry/docs

Accurate. The rule exists and is type-aware: it returns `{}` when no `program`/`esTreeNodeToTSNodeMap` is present (`index.js:1054-1055`), otherwise flags `JSON.parse(arg)` when `isAnyOrUnknownType(getTypeAtLocation(arg))` and not `hasLocalStringBoundary` (`index.js:1059-1069`). Registry records `status: ready, stable: false, signal: TypeChecker` (`rules.yaml:514-517`), which matches. The reference doc (`no-unsafe-deserialize.md:104-108`) and inventory (`stable-promotion-inventory.md:12`) both describe it as a stable-review candidate with the guarded-`any` concern resolved and two drift repos — consistent with the corpus cases (`external-corpus.mjs:55-69` Sudocode, `327-369` Cloudflare).

## 2. Ecosystem overlap

Partial only, correctly classified (`rules.yaml:528-532`). `@typescript-eslint/no-unsafe-argument` fires on `any` passed to `JSON.parse`'s `text: string` param, so it overlaps the `any` branch. It does **not** replace this rule: (a) the `unknown` branch is largely moot upstream since `unknown` isn't assignable to `string` (a compile error), so the real differentiator is the `any` case plus parse-at-edge intent; (b) crucially, no-unsafe-argument has no string-boundary guard exemption, so it would false-positive on the guarded `MessageEvent.data` Twilio control (`external-corpus.mjs:371-379`). That control is the strongest argument for owning it.

## 3. Strongest signal

TypeChecker is primary and deterministic: `getTypeAtLocation` → any/unknown flag bits (`index.js:1186-1188`). The AST/control-flow exemption (`hasLocalStringBoundary`, `index.js:1034-1048`) is a legitimate *compensation* for a TS/DOM declaration limit (`MessageEvent<T=any>.data` vs. `JSON.parse(text: string)`), which fits the project constraint allowing AST when it compensates for a checker declaration limit. No registry dependency. This is a well-grounded signal hierarchy.

## 4. Concrete false-positive / false-negative risks

False positives:
- **Helper-function string guards.** The exemption only matches a direct `typeof <sameExpr> === "string"` branch or early return (`index.js:948-959`). `if (!isString(event.data)) return; JSON.parse(event.data)` still flags.
- **Guard broken by an intervening initialized statement.** `previousGuardInBlockEnsuresString` only skips uninitialized var declarations between guard and parse (`index.js:1005-1019`); any other statement defeats recognition.
- **Shadowed `JSON`.** Callee match is by identifier name only (`index.js:1062`), so a local `JSON` binding would be misattributed.

False negatives:
- **parserServices absent → total no-op** (`index.js:1054-1055`). Any consumer config without a type-aware `project` silently disables the rule everywhere.
- **Aliased/computed parse.** `const {parse}=JSON; parse(x)` or `JSON["parse"](x)` are not matched.
- **Wrongly-narrowed input.** A value cast to `string` (`JSON.parse(x as string)`) or typed as a too-loose non-`any` type won't flag — by design, but a real laundering path.

## 5. Stable-promotion readiness

The repo's own bar (`rules.yaml:12-19`) is essentially met: two independent real drift repos not created for the test (Sudocode `workflows.ts`, Cloudflare `server.ts`/`client.tsx`), clean controls across four repos (`real-corpus-validation.md:108`), and the guarded-`any` FP resolved. The only ledger blocker is "final promotion review/advisory" (`rules.yaml:525`, `stable-promotion-inventory.md:55-56`) — i.e. this review.

**Recommendation: keep `stable: false` for now**, with one concrete blocker to close first:

- **The parserServices no-op is an unresolved production concern** (`productionConcerns: none` is required). Today the rule fails open: in a non-type-aware config it reports nothing, which is the worst failure mode for a security rule (silent FN, no signal). This should be a *documented, enforced* decision — e.g. guarantee via the shared eslint-config that this rule only ships in type-aware blocks, and/or note the no-op in the reference doc — before `productionConcerns` can honestly read `none`.

Once that is recorded and the FN surface in §4 (aliased parse, helper-based guards) is explicitly accepted as documented limitations rather than gaps, the rule is genuinely promotable. The evidence itself is strong; the gap is hygiene/documentation, not signal quality.

## 6. Productionization concerns

- **parserServices no-op (highest).** `index.js:1054-1055` silently disables the rule. All four corpus cases set `typeAware: true` (`external-corpus.mjs:60-61` etc.), so the gate never exercises the no-op path — the gate cannot detect a misconfigured consumer. Address explicitly.
- **Performance.** One `getTypeAtLocation` per `JSON.parse` call only; negligible beyond the inherent cost of type-aware linting.
- **Path/corpus.** Discovery is hardcoded to `/Users/sushi/code/*` with env overrides (`external-corpus.mjs:6-21`); portable via skip when absent. Drift evidence is in genuinely external repos — satisfies "not introduced for test."
- **Duplicate reports.** None — one report per `CallExpression` (`index.js:1068`). Note drift cases assert a single line (e.g. `199`) though the file has 8 findings (`no-unsafe-deserialize.md:74`); this under-asserts but does not over-report.
- **String-boundary exemption.** Sound and narrow (`index.js:1034-1048`), correctly does *not* exempt parsed subfields like `JSON.parse(msg.event)` (`no-unsafe-deserialize.md:102`), proven by the Cloudflare drift case. Its narrowness is the main residual FP risk per §4.

**Bottom line:** Strong rule, evidence meets the two-repo/clean-control bar, ecosystem ownership justified. Keep `stable: false` until the parserServices fail-open behavior is recorded and mitigated as a documented production decision; after that, promote.
