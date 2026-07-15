## Adversarial review — `antidrift/no-redundant-zod-parse`

I read the rule (`index.js:1868–2015`), the corpus wiring, the investigation doc, the registry entry, the promotion/validation docs, and the four live corpus files (chaski `sequence-count-router.ts`, murderbox `setup/route.ts` + `workspace-projects.ts`, atlas `generatedStateDebugSimulation.test.ts`).

### 1. Is the assertion-context exception soundly scoped?

Mostly yes, but the **implementation is broader than the doc claims**.

The gate (`isThrowAssertionCallbackParse`, `index.js:1926`) is: nearest enclosing function expression is a direct argument to a call named `expect` (or `expect.*`), and that expect chain terminates in an invoked `toThrow`/`toThrowError`. That is genuinely scoped — not a test-file blanket — and it correctly captures `expect(() => Schema.parse(fixture)).not.toThrow()`. Good.

But doc line 100 promises: *"A redundant parse in a test still reports if the parsed result is assigned, returned, or otherwise consumed as a value."* **The code does not implement that.** It is purely syntactic: any Zod parse lexically inside the throw-callback's nearest function is skipped, regardless of whether the result is bound or consumed:

```ts
expect(() => { const v = Schema.parse(typedThing); return useIt(v); }).not.toThrow()
```

This is silently ignored. So either the doc overstates the precision or the implementation needs a "result is unused" check. This is the single most important gap for an "advisory review before stable" gate, because the doc's own justification for the exception being narrow is the part that isn't enforced.

Two narrower edges, both minor:
- `expect` must be the literal identifier. An aliased import (`import { expect as e }`) → exception silently doesn't apply → over-reporting in that test file.
- Only the **innermost** function is checked (`nearestFunctionExpression`). A parse inside a nested callback within the expect arrow (`expect(() => arr.map(x => Schema.parse(x))).not.toThrow()`) is *not* exempted. Probably acceptable, but it's an inconsistency worth knowing.

### 2. Most likely false positives / false negatives

**False negatives (the bigger surface):**
- **Inlined await defeats the rule.** Both report branches require `arg.type === "Identifier"`. `Schema.parse(await setupMachine(id))` — arg is an `AwaitExpression` — is missed. The murderbox drift can be trivially rewritten into this shape and slip through.
- **Sync helpers are invisible.** `callResultSymbols` is populated only from `isAwaitedCallInitializer` (`index.js:1942`, requires `await` + CallExpression). A synchronous helper returning schema output that is re-parsed is never caught.
- **Destructuring / reassignment.** `const { data } = await call()` or `let`-rebinding bypass both provenance maps.

**False positives:**
- **Type-level provenance can lie.** The service-to-boundary branch trusts the *type* of the awaited result. A gateway typed `Promise<MachineSetupResponse>` that merely casts DB rows (no runtime validation) would make a genuine **first** boundary parse look redundant. Bidirectional assignability + the any/unknown guards mitigate structural drift but cannot detect "the annotation is a cast, not a validation." No corpus control exercises this case; it's the core philosophical risk of type-aware provenance and should be documented as a known limitation.
- The any/unknown guard `typeStringIncludesAnyOrUnknown` is applied to `parseReturnType` only, not `argType` (`index.js:1946`). A structurally-`any`-bearing arg can still match. Niche.

### 3. Does it still catch the original production drift after the exception?

**Yes — verified against live source.**
- chaski `sequence-count-router.ts:21`: `z.array(CountSequenceRowSchema).parse(rows)` where `rows = await ctx.gateways!.bigquery.getCountSequenceRows(...)`. Schema callee is a CallExpression (so `schemaSym` is undefined and branch 1 is skipped), but branch 2 fires: awaited-call result + bidirectional `CountSequenceRow[]` match. Caught.
- murderbox `setup/route.ts:27`: `machineSetupResponseSchema.parse(result)`, `result = await setupMachine(...)`. Branch 2 fires. Caught.

Neither sits inside an `expect(...).toThrow` callback, so the exception cannot touch them (`nearestFunctionExpression` hits the `async function POST`/`.query` arrow, whose parent is not an `expect` call). The exception is orthogonal to the drift gates. Good.

The clean control `workspace-projects.ts` is correctly clean — its `workspaceProjectRegistrySchema.parse(registry)` (lines 158/179) operates on a **parameter** typed as the schema output, and the rule deliberately tracks neither parameter provenance nor write-boundary reparses. This confirms the rule is conservative rather than that the control is weak.

### 4. Promote stable now?

**Do not promote yet — promote after specific small changes.** The registry already sets `stable: false` pending advisory review, and the corpus is thin for a stable bar: drift is 2 repos × 1 finding each, and the *exception itself has no negative gate*. Every atlas exception case is a clean-pass; nothing proves a **consumed** parse inside a test still reports — which is precisely the claim that distinguishes this from a test-file blanket exemption.

Conditions to promote:
1. **Add a drift gate** (atlas or sudocode test file) where a Zod parse inside a test assigns/returns its result and is expected to **still report** — this locks the "not a blanket exemption" promise. If you don't enforce it in code, reconcile doc line 100 to match the purely-syntactic behavior instead.
2. **Document the two known FN/FP limits** in the investigation doc: inlined-`await` arg and sync-helper results are out of scope; type-provenance trusts annotations (cast-not-validation can false-positive).
3. Optionally harden `isExpectCall` for aliased `expect` only if any corpus repo aliases it.

Item 1 is the real blocker; 2 is a doc edit; 3 is optional.

### 5. AST-traversal concerns

- **Visit ordering is sound.** ESLint visits top-down, so `const v = Schema.parse(raw)` / `const v = await call()` are recorded (`VariableDeclarator` + `recordParsedConst`) before any later `Schema.parse(v)` is evaluated. Symbol-identity keys (`validatedBy`, `callResultSymbols`) are robust against name shadowing.
- **`hasThrowAssertionMatcher`** walking arbitrary `MemberExpression`/`CallExpression`/`ChainExpression` is fine because it requires the matched matcher member to actually be invoked (`current.parent.callee === current`), so a bare `.toThrow` reference won't trigger.
- **`isZodMethod`** confirming the symbol declaration lives under `node_modules/zod` is the right call (no name-gating) and the reason this is type-aware rather than heuristic.
- No correctness bug found in traversal; the gaps are scope/coverage (§2), not crashes or mis-visits.

**Final recommendation: promote after specific small changes** — chiefly, add a negative gate proving a consumed parse inside a throw-assertion test still reports (or align the doc to the syntactic behavior), and record the inline-await / sync-helper / lying-type limitations. Until then, keep `stable: false`.
