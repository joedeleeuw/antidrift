# Directive Parity and Pathological Semantic Smells

## Purpose

This document records:

1. **The repository boundary between `dotfiles` (`code-health` / `process-review`) and `antidrift`** — why two repositories exist, where ownership blurred, and which repository owns each enforcement surface.
2. **Directive Parity Rules (Tier 1 & Tier 2)** — the 9 rules required to close gaps between `ai-contexts/AGENT.md` / `dotfiles/docs/enforcement-map.md` and `@joedeleeuw/antidrift`, including their required compiler/AST context, false-positive boundaries learned from the `dotfiles` two-corpus studies, and exact implementation specifications.
3. **Ecosystem-Unique Pathological & Pattern Smells (Tier 3)** — 7 high-signal architectural and AI-drift smells that no maintained ecosystem linter (`oxlint`, `eslint`, `typescript-eslint`, `unicorn`, `sonarjs`, `anti-slop`, `biome`) can enforce because they require whole-program `TypeChecker`, schema provenance, call-graph, or React state-transition proof.

---

## 1. Why Two Repositories Exist (`code-health` vs. `antidrift`)

### Different Runtime Engines and Distribution Models

- **`code-health` and `process-review` (in `dotfiles`)** are host-installed polyglot CLIs (`~/.local/bin/code-health`, `~/.local/bin/process-review`).
  - `code-health` is a Python `uv run --script` executable built around Python's `ast` module, `vulture`, `ast-grep`, and Python virtual-environment introspection (`--dependency-shapes PYTHON`). It enforces Python structural metrics (`file_lines`, `complexity`, `nesting`, `params`, `clone_pairs`, `cycles`, `passthrough_params`, `single_call_hops`, `single_adapter_seams`, `test_only_seams`), polyglot config/prose hygiene (`dead_paths`, `shadow_key_prose`, `s9-approval-key`), and ratchets existing debt in `.code-health.json`.
  - `process-review` runs the semantic LLM judgment pass (`Jev` typed yes/no per changed unit) over rules in `config/process-review/rules/*.md`.
- **`@joedeleeuw/antidrift` (in `antidrift`, paired with `@joedeleeuw/typescript-tooling`)** is a versioned npm package consumed inside TypeScript and JavaScript repositories.
  - TypeScript semantic enforcement requires an in-process TypeScript `ts.Program` and `TypeChecker` resolved against the consumer's `tsconfig.json` and `node_modules`, plus ESLint `SourceCode` scope graphs and `eslint-suppressions.json` ratcheting (and native `oxlint` / `tsgolint` execution). A Python `ast` script cannot resolve TypeScript types, symbol aliases, generic instantiations, or declaration files.

### Where Ownership Blurred

Because both systems enforce the same directive table (`G1`–`G26`, `S1`–`S9`, `W4`, `D1`–`D2` in `dotfiles/docs/enforcement-map.md`), two seams blurred:

1. **Regex-based TypeScript scanning inside `code-health`:** `dotfiles/local/bin/code_health/seams.py` (`typescript_single_adapters`) shells out to `ast-grep` and parses matches with Python regular expressions (`re.match(r"(?:export\s+)?interface\s+(\w+)")`). That bypasses TypeScript symbol resolution, misses cross-module imports and generic implements clauses, and splits TypeScript static enforcement across two tools.
2. **Asymmetric directive ports:** Directives `G5`, `G7`, `G8`, `G9` (`elif`), `G10` (function hops), `G21`, `G22`, `S1`, `S4`, `S5`, and `W4` were ported to Antidrift, while `G3` (case-table `: Record` annotation ban), `G4` (inline parse reshape ban), `G9` (`g9-closed-string`), `G10` (`g10-reexport-module`), `G11` (`single_adapter_seams` & `test_only_seams`), `G15` (source-file `readFileSync` in tests), `G18` (`g18-secret-call`), and `D2` (`d2-dict-argument-write`) remained Python/Bash-only or prose-only.

### Clean Ownership Boundary

- **`antidrift` owns 100% of TypeScript and JavaScript static source/type enforcement.** Once `antidrift/no-single-adapter-seam` and `antidrift/no-test-only-seam` ship on the Semantic Kernel (`ts-rule-kernel.mjs`), `typescript_single_adapters` in `dotfiles/local/bin/code_health/seams.py` should be retired so `code-health` never parses TypeScript source.
- **`dotfiles` (`code-health` + `process-review`) owns Python static analysis, repo-wide non-JS/TS config/markdown/shell checks (`Json`, `Yaml`, `Markdown`, `Bash`), and the cross-language `process-review` judgment pass.**

---

## 2. Directive Parity Rules (Tier 1 & Tier 2)

### 2.1 Deepened `antidrift/no-appeasement-erasure` (`caseTableAnnotation` — Directive G3)

- **Directive (`AGENT.md` § Type Safety):**
  > _"To index a case table by a generic key, declare `type Table = { [K in keyof Cases]: (value: Cases[K]) => Out }`, write `const TABLE = { ... } satisfies Table`, and read a row through a typed indexed access (`const row: Table[K] = TABLE[key]`). Do not annotate the binding with a mapped type or `Record`: that erases the table's evidence, and the antidrift lint rejects it."_
- **Superset consolidation & shared logic (`dictionary-types.js` + `no-appeasement-erasure.js`):**
  - Instead of creating a duplicate `no-case-table-type-annotation` rule ID, `antidrift/no-appeasement-erasure` is the single superset owner for variable-annotation evidence erasure (`widening`, `widenThenAssert`, `caseTableAnnotation`, and `unknown` erasure).
  - [`dictionary-types.js`](file:///home/joedeleeuw/code/antidrift/tooling/antidrift/src/oxlint-plugin/anti-slop/shared/dictionary-types.js) exports `isPopulatedObjectExpression` (including `Object.freeze({ ... })`) and `isMutatedObjectBinding` alongside `hasBroadRecordKey`, so `no-known-value-widening` handles open-key dictionaries (`Record<string, V>`, `{ [K in string]: V }`) while `no-appeasement-erasure.js` uses `TypeChecker` (`classifyClosedCaseTableAnnotation`) plus shared `isPopulatedObjectExpression` and `isMutatedObjectBinding` to report closed `Record<ClosedKey, V>` and closed mapped-type (`{ [K in keyof Cases]: ... }`, including resolved type aliases) annotations on immutable `const` object-literal case tables.

### 2.2 Deepened `antidrift/no-redundant-zod-parse` (`inlineObjectReshape` & `inlineConditionalReshape` — Directive G4)

- **Directive (`AGENT.md` § Parse at Boundaries):**
  > _"Never reshape a payload inline to satisfy a schema, as in `parse(x.kind === "ready" ? { kind: "ready" } : x)` or `parse({ text: e.text })`. Define a named decoder at the receiving adapter, built from the owner's contract shapes (for example `z.object(contractSchema.shape)` to drop extra native fields), and parse once."_
- **Superset consolidation & shared logic (`bag-projection.mjs` + `schema-provenance.mjs`):**
  - Instead of creating a separate `no-inline-parse-reshape` rule that walks every `schemaValidationCallParts(node, services, checker)` site a second time, `antidrift/no-redundant-zod-parse` owns all parse-site contract misuse (`inlineObjectReshape`, `inlineConditionalReshape`, same-schema re-parse, and parameter `z.infer` parse-as-cast) across Zod, Valibot, Effect Schema, and TypeBox.
  - Both `antidrift/no-bag-reshaper` and `antidrift/no-redundant-zod-parse` share [`bag-projection.mjs`](file:///home/joedeleeuw/code/antidrift/tooling/antidrift/src/semantic-adapters/bag-projection.mjs) (`classifyInlineParseReshape`, `inspectObjectLiteralBagProjection`, `isPureBagCondition`, `isBagObjectReference`, `inspectBagValueExpression`):
    - **`inlineObjectReshape`:** `arg` is a non-empty `ObjectLiteralExpression` whose non-literal properties (`SpreadAssignment` or `PropertyAssignment`) all project from a single root source symbol `source` (excluding multi-source composite bundles `{ body: rawBody, headers: rawHeaders }` and `.preprocess` / `.transform` combinator callbacks).
    - **`inlineConditionalReshape`:** `arg` is a `ConditionalExpression` (`x.kind === "ready" ? { kind: "ready" } : x`) with a pure condition on `source` and inline object-literal reshaping on at least one branch.

### 2.3 Deepened `antidrift/no-repo-state-mirror-assertion` (Built-In Source-File Read Taint — Directive G15)

- **Directive (`AGENT.md` § Testing & `~/code/AGENTS.md` § Smoke-First Validation):**
  > _"Avoid contract/guard tests that `readFileSync` a source module and assert it `.toContain("someCode")` / matches a code shape: they prove nothing about behavior, break on every refactor, and are treated as noise. Don't write them; remove them when found."_
- **Superset consolidation & shared taint engine (`no-repo-state-mirror-assertion.js`):**
  - Rather than adding a duplicate `no-source-file-read-in-test` rule with a parallel taint tracker, [`no-repo-state-mirror-assertion.js`](file:///home/joedeleeuw/code/antidrift/tooling/antidrift/src/oxlint-plugin/rules/no-repo-state-mirror-assertion.js) integrates `sourceFileReadCallName(target, sourceCode)` directly into `taintRootName(node)` and adds `toMatch`, `toMatchSnapshot`, and `toMatchInlineSnapshot` to `EQUALITY_MATCHERS`.
  - Calls to `readFileSync`, `readFile`, `fs.readFileSync`, `fs.promises.readFile`, `fsPromises.readFile`, or `Bun.file(...).text()` whose path argument (literal, template literal, `path.join`/`path.resolve`, `new URL(..., import.meta.url)`, or local path variable) ends with a source-code extension (`.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.py`, `.go`, `.rs`, `.css`, `.scss`, `.vue`, `.svelte`) outside fixture/snapshot/build paths flow through the existing variable, `for..of`, callback, and member-expression taint engine and work out-of-the-box with zero configuration.

### 2.4 `antidrift/no-bag-reshaper` (Directives G4, G8, G10 & W4 — "Provide a Bag, Return a Type I Want" and "Provide a Bag, Return a Bag")

- **Directives (`AGENT.md` § Parse at Boundaries & § Code Design):**
  > _"Within an established typed flow, project values directly instead of reparsing them, copying contract shapes, or adding wrapper types and conversion helpers."_
  > _"Delete bug-hunt residue: nested ternaries and status chains, guards the types already rule out, polling or re-deriving values an owner already holds, fallbacks that never fire, and adapters that re-decide what the server validates."_
- **Why `antidrift/no-contract-appeasement-projection` misses both patterns today:**
  1. In [`no-contract-appeasement-projection.js`](file:///home/joedeleeuw/code/antidrift/tooling/antidrift/src/eslint-plugin/rules/no-contract-appeasement-projection.js#L460), `collectReturnRecordsFromExpression` treats any returned `ObjectExpression` (`return { ... }`) as `{ kind: "unsupported" }`. It only inspects scalar returns (`return file.source;`).
  2. `no-contract-appeasement-projection` requires an explicit `: ReturnType` annotation (`hasExplicitReturnType(fn)`), so it never inspects functions with inferred object-literal return types.
- **The two target pathologies:**
  1. **`bagToContract` ("Provide a bag, return a type I want"):**
     A function accepts a bag — an inline `{ ... }` parameter type, `Partial<T>`, `Record<string, unknown>`, a destructured `{ a, b, c }` bag, or a source object contract `Source` — and returns an `ObjectLiteralExpression` claiming a named target contract (`: TargetContract`, `as TargetContract`, or `satisfies TargetContract`) whose properties are merely plucked, renamed, spread, defaulted (`??` / `||`), or trivially coerced (`String(...)`, `Number(...)`, `Boolean(...)`) from the input bag:
     ```ts
     function toUserRow(input: {
       id: string;
       email: string;
       name?: string | null;
     }): UserRow {
       return {
         id: input.id,
         email: input.email,
         name: input.name ?? "Anonymous",
       };
     }
     ```
     Instead of decoding at the untrusted boundary with a schema (`UserRowSchema.parse(raw)`) or passing the owner's `UserRow` directly, the function acts as a hand-rolled, unvalidated conversion adapter or appeasement mapper.
  2. **`bagToBag` ("Provide a bag, return a bag"):**
     A function accepts an object/bag parameter and returns a new ad-hoc `ObjectLiteralExpression` (with an inferred anonymous object return type or an inline `{ ... }` / `Record<...>` / `Partial<...>` return annotation) whose properties are merely plucked, renamed, spread, defaulted, or trivially coerced from the input bag:
     ```ts
     function normalizeFilters(params: {
       teamId: string;
       status?: string;
       includeArchived?: boolean;
     }) {
       return {
         team_id: params.teamId,
         status: params.status ?? "active",
         include_archived: Boolean(params.includeArchived),
       };
     }
     ```
     Neither the input nor the output is an owned domain contract; the function is a shallow object-repacking hop that hides field provenance and spawns parallel anonymous structural shapes across the call graph.
- **Required context:** `defineTypeScriptRule` (`ts-rule-kernel.mjs`) + shared [`bag-projection.mjs`](file:///home/joedeleeuw/code/antidrift/tooling/antidrift/src/semantic-adapters/bag-projection.mjs) in `src/semantic-adapters/`.
- **Implementation specification:**
  1. **Callable & parameter gate:** Inspect non-generated function declarations, arrow/function expressions, and methods that have `>= 1` object-shaped parameter (an `ObjectBindingPattern` `{ a, b }`, an inline `TypeLiteralNode` `{ ... }`, `Record<...>`, `Partial<...>`, or a parameter whose `checker.getTypeAtLocation(param)` is an object/interface type, excluding primitives, arrays, functions, and class instances with methods).
  2. **Return-path gate:** Collect all return expressions (handling concise arrow bodies, `return` statements, `if`/`else`, and conditional `? :` branches). Ignore `undefined`/`null` guard returns; require `>= 1` meaningful return expression and require every meaningful return expression (unwrapping parenthesized, `as T`, and `satisfies T` wrappers) to be a non-empty `ObjectLiteralExpression`.
  3. **Pure bag-projection property proof:** Verify that every property in each returned `ObjectLiteralExpression` is derived from the parameter bag(s) without domain computation, I/O, or schema decoding:
     - `SpreadAssignment` (`...bag`), or
     - `PropertyAssignment` / `ShorthandPropertyAssignment` whose value expression (after unwrapping `expr ?? defaultLiteral`, `expr || defaultLiteral`, `expr ? literalA : literalB`, and primitive wrappers `String(...)`, `Number(...)`, `Boolean(...)`) is a direct parameter binding (from `{ a, b }`), a member chain rooted at a parameter bag (`bag.a`, `bag.nested.a`), or a static literal tag (`kind: "ready"`), with **at least 1 property** reading from a parameter bag.
  4. **Classification (`bagToContract` vs. `bagToBag`):**
     - **`bagToContract` ("Provide a bag, return a type I want"):** The function declares an explicit return type `: TargetType` or wraps the returned object literal in `as TargetType` / `satisfies TargetType`, where `TargetType` resolves via `TypeChecker` to a named `interface`, `type` alias, or schema-inferred contract (`z.infer<...>`). Report `bagToContract`: pass the owner's contract directly or decode at the boundary with the owner's schema instead of reshaping a bag into `TargetType`.
     - **`bagToBag` ("Provide a bag, return a bag"):** The function has an inferred return type or an inline `TypeLiteralNode` / `Record<...>` / `Partial<...>` return annotation. Report `bagToBag`: delete the intermediate bag-repacking helper and pass or destructure the owner's fields at the call site.
  5. **Clean controls (do not report):**
     - **Real domain computation:** Any property value that calls a domain function, method (e.g., `.trim()`, `.map()`, `.filter()`, ` path.join()`), arithmetic/string concatenation, `new` constructor, or `await` expression.
     - **Schema decoders / boundary parsers:** Functions that call `.parse` / `.safeParse` / `Schema.decode*`.
     - **State reducers:** Functions matching `(state, action) => ({ ...state, ... })` passed to `useReducer` or state stores where `action` is a discriminated union.

### 2.5 `antidrift/no-test-only-seam` (Directive G11 — `test_only_seams` Parity)

- **Directive (`AGENT.md` § Code Design & `dotfiles/docs/enforcement-map.md` G11):**
  > _"One adapter means a hypothetical seam; two means a real one, so no port unless a production and a test adapter are both justified."_
  > In `dotfiles/local/bin/code_health/seams.py`, `test_only_seams` scored **27/27 (100% precision)** across 4 repositories, but is implemented only for Python ASTs.
- **Current gap:** TypeScript functions and constructors that add default dependency parameters (`function deploy(id: string, exec = execFileSync)` or `constructor(private readonly now: () => number = Date.now)`) solely so a unit test can pass a fake, while zero production call sites ever pass that parameter.
- **Required context:** `defineTypeScriptRule` (`ts-rule-kernel.mjs`) + program-wide call-site indexing (`wrapping-functions.mjs`).
- **Implementation specification:**
  1. In production files (non-test, non-generated), inspect function declarations, method declarations, and class constructors that declare a parameter with a default initializer (`param = defaultExpr`) or an options-bag property default (`{ exec = execFileSync } = {}`).
  2. Verify that `defaultExpr` is an **effectful dependency** (matching `seams.py#is_dependency`):
     - A first-party function imported or declared at module scope, OR
     - A callable from an effectful runtime module or global (`node:fs`, `node:fs/promises`, `node:child_process`, `node:net`, `node:http`, `node:https`, `node:crypto`, `fetch`, `Date.now`, `performance.now`, `crypto.randomUUID`, `Math.random`, `setTimeout`).
     - Pure configuration values (numbers, strings, booleans, options objects, class constructors, schema objects) are skipped.
  3. Verify that the function calls `param(...)` or (in a constructor) assigns `this.field = param` (or `private readonly param = defaultExpr`).
  4. Exclude exported entrypoints of published library packages (`package-entry-points.mjs`) whose external consumers are outside the repository.
  5. Collect all call sites of the function/class across `program.getSourceFiles()`:
     - Report when **0 production call sites** supply an explicit argument for `param` and **`>= 1` test call sites** supply it (or `0` callers anywhere supply it).

### 2.6 `antidrift/no-single-adapter-seam` (Directive G11 — `single_adapter_seams` Parity)

- **Directive (`AGENT.md` § Code Design & `dotfiles/docs/enforcement-map.md` G11):**
  In `dotfiles/local/bin/code_health/seams.py`, `single_adapter_seams` scored **20/20 (100% precision)** across 22 repositories. Currently `seams.py` scans TypeScript via `ast-grep` regexes over raw text.
- **Current gap:** Regex scanning over `interface` and `implements` cannot resolve imported symbols, aliased interfaces, generic `implements Foo<T>` clauses, or TypeScript structural satisfaction across modules, and splits TypeScript static enforcement outside Antidrift.
- **Required context:** `defineTypeScriptRule` (`ts-rule-kernel.mjs`) program-wide symbol & type analysis.
- **Implementation specification:**
  1. Index all non-test, non-generated `abstract class` declarations and `interface` declarations across `program.getSourceFiles()` (excluding `.d.ts` files and exported public package entrypoints).
  2. An `interface` is a **seam** (rather than a plain data shape) only when at least one class in the program `implements` it (matching `seams.py` line 6: _"a TypeScript interface that some class implements (an interface nothing implements is a data shape)"_).
  3. Count adapters across `program.getSourceFiles()` (including test files) by resolved `ts.Symbol` identity:
     - `class C implements Seam` or `class C extends AbstractSeam` (ignoring subclasses that are themselves extended by further subclasses),
     - Object literals annotated with `: Seam` or `satisfies Seam`,
     - Test files passing a non-`new` fake to a parameter or property typed as `Seam`.
  4. Report when a production seam has **exactly 1 adapter** in the entire program and that adapter is in production code (i.e., there is neither a second production adapter nor a test adapter).

### 2.7 `antidrift/no-closed-string-parameter` (Directive G9 — `g9-closed-string` Parity)

- **Directive (`AGENT.md` § Code Design & `dotfiles/config/code-health/rules/g9-closed-string.yml`):**
  > _"Declare the case space first."_
  > In `dotfiles`, `g9-closed-string` scored **19/20 (95% precision)** across 19 repositories.
- **Current gap:** Antidrift enforces `no-else-if-chain` (G9), but does not flag functions or class fields typed as widened `string` that immediately validate membership against a closed literal set at runtime and throw.
- **Required context:** `defineTypeScriptRule` (`ts-rule-kernel.mjs`) — `sourceFile` and `checker`.
- **Implementation specification:**
  1. In non-test, non-generated files, inspect any function/method parameter `param` or class property `this.field` whose explicit type annotation is `ts.SyntaxKind.StringKeyword` (`string`).
  2. Skip functions that implement or override a signature from a class heritage clause, contextual callback type, or untrusted boundary decoder (e.g., functions that also accept `unknown` or parse CLI `process.argv` / `URLSearchParams` / `req.query` / `headers`).
  3. Match an `if` statement in the function body whose consequent `throw`s (or returns an error) and whose condition negates membership of `param` (or `this.field`) in a closed literal set:
     - `!LITERAL_ARRAY.includes(param)` or `!LITERAL_SET.has(param)` where `LITERAL_ARRAY` / `LITERAL_SET` resolves to a module-scope constant of `>= 2` string literals (excluding `Record` / `Map` / object registries, matching `g9-closed-string.yml` line 26), OR
     - `param !== "a" && param !== "b"` (`>= 2` string literal inequality conjunctions).
  4. Report the `string` annotation: declare the literal union type on the parameter or field so callers and the type checker see the case space.

### 2.8 `antidrift/no-reexport-only-module` (Directive G10 — `g10-reexport-module` Parity)

- **Directive (`AGENT.md` § Code Design & `dotfiles/config/code-health/rules/g10-reexport-module.yml`):**
  > _"A function whose body is one call is a hop, not an owner; delete it and let the caller name the owner. The same goes for a module that re-exports one symbol... A split moves code and updates every importer in the same commit: no re-export shims."_
  > In `dotfiles`, `g10-reexport-module` scored **15/17 (88% precision)** across 8 repositories.
- **Current gap:** Antidrift enforces `no-wrapping-functions` for function hops, but has no rule for barrel/shim modules whose only statements re-export symbols from other modules.
- **Required context:** Oxlint / portable AST + package entrypoint resolution (`package.json` `exports` / `main` / `bin`).
- **Implementation specification:**
  1. Inspect `Program.body` in non-test, non-`.d.ts`, non-generated files.
  2. Ignore files declared as public package entrypoints in the enclosing `package.json` (`exports`, `main`, `module`, `bin`) and public facade files that only re-export from an underscore-prefixed private sibling (`export * from "./_internal"`).
  3. Report the module when `Program.body` is non-empty and every statement is an `ExportNamedDeclaration` with `source !== null` (`export { a } from "./b"`), an `ExportAllDeclaration` (`export * from "./b"`), or an `ImportDeclaration` whose bindings are only used in `export { a }`.

### 2.9 `antidrift/no-argument-mutation-side-effect` (Directive D2 — `d2-dict-argument-write` Parity)

- **Directive (`skills/codebase-design` § Designing for Testability & `dotfiles/config/code-health/rules/d2-dict-argument-write.yml`):**
  > _"Return results, don't produce side effects."_
  > In `dotfiles`, `d2-dict-argument-write` scored **17/20 (85% precision)** across 15 repositories.
- **Current gap:** Standalone TypeScript functions that return `void` / `Promise<void>` and write their computed output into named keys of a plain object, `Record`, or `Map` argument instead of returning a value.
- **Required context:** `defineTypeScriptRule` (`ts-rule-kernel.mjs`) — `sourceFile` and `checker`.
- **Implementation specification:**
  1. In non-test, non-generated files, match standalone module-level function declarations (or exported arrow/function expressions) that are **not** class methods, generators, or framework middleware/callbacks (e.g., Express `(req, res, next)` or DOM event listeners).
  2. Require that the function returns no value (`return;` or no `return` statement; return type `void` or `Promise<void>`).
  3. Check whether the function body mutates a parameter `param` via `param.field = value`, `param[key] = value`, or `param.set(key, value)` where:
     - `param` is **not** named `cache`, `memo`, `ctx`, `context`, `store`, `state`, `headers`, `res`, `response`, or `target` (matching the `d2-dict-argument-write.yml` narrowings),
     - `param` is **not** rebound to a local clone (`param = { ...param }` or `param = structuredClone(param)`), and
     - `checker.getTypeAtLocation(param)` is a plain object literal type, an interface with only data properties (no methods), `Record<K, V>`, or `Map<K, V>` (excluding class instances, streams, DOM nodes, and `Set`).
  4. Report the parameter write and instruct returning the computed result instead.

### 2.10 `antidrift/no-direct-secret-cli-call` (Directive G18 — `g18-secret-call` Parity)

- **Directive (`AGENT.md` § Secrets & `dotfiles/config/code-health/rules/g18-secret-call.yml`):**
  > _"Resolve automation secrets with `~/.local/bin/secret-resolve` — never hardcode keys or call `secret-tool`/`op` directly."_
- **Current gap:** `g18-secret-call.yml` enforces this in `Bash` and `Python`, leaving TypeScript/JavaScript scripts (`execSync`, `execFileSync`, `spawn`, `Bun.spawn`, `Bun.$`, `execa`) unchecked.
- **Required context:** Oxlint / portable AST.
- **Implementation specification:**
  1. Outside `secret-resolve*` and `secret-provision*` scripts and test files, inspect call expressions and tagged templates that execute subprocesses (`exec`, `execSync`, `execFile`, `execFileSync`, `spawn`, `spawnSync`, `Bun.spawn`, `Bun.spawnSync`, `$`).
  2. Report when the command string or `[cmd, ...args]` array invokes:
     - `secret-tool`,
     - `op` with subcommands `read` or `item` (`item get`), or
     - `security` with `find-generic-password` and `-w` / `-g`.

---

## 3. Ecosystem-Unique Pathological & Pattern Smells (Tier 3)

These 7 rules target high-frequency AI and architectural pathologies that **cannot be expressed in any existing open-source linter** because they require Antidrift's cross-module `TypeChecker`, Schema Provenance, Call-Graph, or React State-Graph primitives.

### 3.1 `antidrift/no-catch-error-text-branching` (Directive G4 / G7 — Stringly-Typed Error Outcome Recovery)

- **Pathology:** Code catches an error (`catch (err)` or `.catch((err) => ...)`) and branches on `err.message.includes("not found")`, `err.message.startsWith("ENOENT")`, or `/timeout/i.test(String(err))` to decide control flow (retry, fallback, HTTP status mapping) instead of reading a structured error discriminant (`err.code`, `err.status`, `err._tag`, `instanceof`).
- **Why ecosystem linters cannot enforce it:** Single-file AST rules cannot tell whether the error source exposes a structured discriminant or whether the matched string is an internal prose message thrown elsewhere in the repository.
- **Deterministic proof on the Semantic Kernel:**
  1. Inside a `catch` clause or `.catch()` callback, match conditional tests (`if`, `? :`, `switch`) that inspect `.message` or `String(err)` via `.includes(...)`, `.startsWith(...)`, `.endsWith(...)`, `.match(...)`, `===`, or `RegExp.test(...)`.
  2. Report when either:
     - **Structured discriminant already exists on the caught or narrowed error:** Either `err` (or another branch in the same `catch` block) narrows `err` to a type that owns a structured discriminant property (`code`, `status`, `statusCode`, `_tag`, `kind`, `errno`), OR a `try`-block callee returns/throws a declared error type in the `ts.Program` with those properties, OR
     - **First-party error prose match (`cross-module-constant-strings.mjs`):** The string literal matched in `.includes("...")` (`>= 3` words) matches a string literal passed to `new Error("...")` / `new CustomError("...")` in a first-party module of the same `ts.Program`.

### 3.2 `antidrift/no-speculative-fallback-on-owned-contract` (Directive G8 / G7 — Bug-Hunt Residue Against Owned Contracts)

- **Pathology (`AGENT.md` § Code Design):**
  > _"Delete bug-hunt residue: nested ternaries and status chains, guards the types already rule out, polling or re-deriving values an owner already holds, fallbacks that never fire."_
  > Agents routinely write `user.id ?? ""`, `config.timeoutMs ?? 5000`, or `Array.isArray(order.items) ? order.items : []` on a value whose type was **just decoded by a schema or returned by a first-party typed owner where the property is required and non-nullable**.
- **Why `@typescript-eslint/no-unnecessary-condition` fails in practice:** The upstream rule triggers heavily on array index accesses (`items[i]`), `Record<string, T>` dictionary lookups (`map[key]`), and loop-mutated variables whenever `noUncheckedIndexedAccess` is not enabled everywhere, forcing teams to disable it.
- **Deterministic proof on the Semantic Kernel:**
  1. Match `expr ?? fallback`, `expr || fallback` (where `expr` cannot be legitimately empty/zero by domain contract, or specifically `??` nullish coalescing), and `typeof expr.prop === "..."` / `Array.isArray(expr.prop)` guards.
  2. Require `expr` to be a direct member access `base.prop` (never an element access `base[i]` and never an index signature) where:
     - `base`'s type comes from a **first-party interface/type alias or schema-decoded output (`z.infer`, Effect `Schema.Schema.Type`, Valibot `InferOutput`)**,
     - `prop` is a **declared, required property** on `base`'s type, and
     - `checker.getTypeAtLocation(expr)` has **no `null`, `undefined`, `any`, or `unknown` constituent**.
  3. Report the dead fallback/guard: the contract already guarantees `base.prop` is present and typed.

### 3.3 `antidrift/no-shadow-state-mirror-in-react` (Directive G8 / `react-state` Skill — Derived State Stored in `useState`)

- **Pathology:** A component initializes `const [value, setValue] = useState(props.value)` (or from a query hook result `data.value`) and synchronizes it in `useEffect(() => { setValue(props.value); }, [props.value])`, while **no event handler or callback ever calls `setValue`**. The state cell is a redundant, tear-prone cache of a prop or query value that should be derived during render.
- **Why ecosystem linters cannot enforce it:** `react/react-compiler` flags some effect derivations, and `eslint-plugin-you-might-not-need-an-effect` uses syntactic heuristics that false-positive when `setValue` is also called by an `onChange` handler (a legitimate resettable draft/form state).
- **Deterministic proof on the React State Graph (`local-ast-rules.mjs`):**
  1. Reuse the per-component state cell and setter reference graph in `src/semantic-adapters/local-ast-rules.mjs`.
  2. Identify any `useState(initialArg)` cell `[stateBinding, setterBinding]` where either `initialArg` references a component prop / hook result, or `setterBinding` is called inside a `useEffect` / `useLayoutEffect` callback with an expression derived from props or hook results.
  3. Classify every reference to `setterBinding` across the component scope:
     - If **`>= 1` call to `setterBinding` is inside an effect hook** (or `0` calls to `setterBinding` exist anywhere in the component) AND **`0` calls to `setterBinding` occur in event handlers, returned callbacks, or JSX props** (nor is `setterBinding` passed down as a prop/returned), report the state cell as a shadow mirror of already-owned state.

### 3.4 `antidrift/no-schema-field-restatement` (Directive G4 / W4 — Runtime Schema Shape Clones)

- **Pathology (`AGENT.md` § Parse at Boundaries):**
  > _"Define a named decoder at the receiving adapter, built from the owner's contract shapes (for example `z.object(contractSchema.shape)` to drop extra native fields), and parse once."_
  > Agents copy-paste 3+ field validator chains across multiple `z.object({ ... })` / `v.object({ ... })` / `Schema.Struct({ ... })` definitions instead of composing from the owner schema with `.pick()`, `.omit()`, `.extend()`, or `.shape`.
- **Why ecosystem linters cannot enforce it:** `no-duplicated-object-field-blocks` and `no-structural-type-fork` operate on TypeScript `type` and `interface` AST nodes, not runtime schema builder call trees.
- **Deterministic proof on Schema Provenance (`schema-provenance.mjs`):**
  1. Across `program.getSourceFiles()` (or within a module and its imported first-party schema modules), extract object schema declarations (`z.object({ ... })`, `v.object({ ... })`, `Schema.Struct({ ... })`, `Type.Object({ ... })`).
  2. Normalize each property's validator chain AST into a canonical structural fingerprint (e.g., `email: z.string().email()`).
  3. Report when two first-party object schemas in the same domain/module family share **`>= 3` properties with identical normalized validator chains** and neither derives from the other via `.pick`, `.omit`, `.extend`, `.merge`, `.shape`, or `Schema.pick` / `Schema.omit`.

### 3.5 `antidrift/no-bag-of-optionals-discriminated-state` (Directive G9 / `domain-modeling` — Flat Optional Bags Encoding Disjoint States)

- **Pathology:** A type declares a closed state discriminant (`status: "loading" | "ready" | "error"`) alongside optional payload/error fields (`data?: T; error?: string; completedAt?: number`) instead of a discriminated union, forcing every consumer to write redundant double-guards (`if (state.status === "ready" && state.data)`) or non-null assertions (`state.data!`).
- **Why ecosystem linters cannot enforce it:** Without inspecting how consumers across the `ts.Program` narrow the type, a linter cannot distinguish a legitimate orthogonal options object (`{ mode: "fast" | "slow"; timeout?: number; label?: string }`) from a flattened state machine whose optional fields are coupled to specific discriminant values.
- **Deterministic proof on the Semantic Kernel:**
  1. Identify first-party `type` or `interface` declarations that have:
     - Exactly 1 discriminant property (`status`, `state`, `kind`, `type`, `phase`, `stage`) typed as a union of `>= 2` string literals, AND
     - `>= 2` optional properties (`prop?: T` or `prop: T | undefined` / `T | null`).
  2. Scan consumer member accesses on values of that type across `program.getSourceFiles()`:
     - Report when consumers guard or assert an optional property **inside a branch that narrows the discriminant property to a specific literal** (e.g., inside `if (x.status === "ready")`, code writes `x.data!` or `if (x.data)`), proving the optional property is state-coupled variant data that belongs in a discriminated union branch.

### 3.6 `antidrift/no-lossy-error-rethrow` (Directive G7 — Catch-and-Rethrow That Strips Error Identity or Only Logs and Rethrows)

- **Pathology:**
  1. **`lossyErrorRethrow`:** Inside `catch (err)` or `.catch((err) => ...)`, code writes `throw new Error(err instanceof Error ? err.message : String(err))` or `throw new Error(err.message)` without adding a typed domain error class (`RequestError`, `ValidationError`) or domain context. Re-wrapping a caught error into a bare `new Error(err.message)` destroys the original prototype (`instanceof`), custom fields (`code`, `status`), and stack frame origin.
  2. **`catchLogRethrow`:** Inside `catch (err)` or `.catch((err) => ...)`, code only logs the error (`console.error(err)`, `logger.error(err)`, `log.warn(err)`) and immediately rethrows the identical error (`throw err` or `return Promise.reject(err)`), duplicating error logs at every call-stack hop instead of handling the failure at the boundary or enriching the error with context.
- **Why `preserve-caught-error` and `ai-guard/no-catch-log-rethrow` are insufficient:** Native `preserve-caught-error` only checks whether `{ cause }` is passed when a new `Error` is thrown; it allows `throw new Error(err.message, { cause: err })` in a catch block that adds zero context and strips the typed error class, and misses `.catch((err) => Promise.reject(new Error(err.message)))`. `ai-guard/no-catch-log-rethrow` only matches `console.*` + bare `throw err` in `CatchClause`, missing `logger.*` / `log.*`, `.catch(...)` promise handlers, and combined log + lossy `new Error(err.message)` re-wraps.
- **Deterministic proof (Oxlint / AST + Scope):**
  1. Inside a `catch (err)` clause or `.catch((err) => ...)` handler whose statements consist only of optional `console.*` / `logger.*` / `log.*` calls followed by a `throw` or `Promise.reject(...)`:
  2. Report `lossyErrorRethrow` when the thrown/rejected expression is a bare `new Error(...)` (not a custom error subclass or domain error constructor) whose message argument is solely `err.message`, `String(err)`, `err instanceof Error ? err.message : String(err)`, or `` `${err}` `` / `` `${err.message}` `` (with no added context prefix/interpolation or structured error class).
  3. Report `catchLogRethrow` when the handler contains `>= 1` logging call (`console.error`, `console.warn`, `console.log`, `logger.error`, `logger.warn`, `log.error`, `log.warn`) and rethrows/rejects the unmodified caught `err` binding.

### 3.7 `antidrift/no-boolean-flag-mode-parameter` (Directive G9 / `codebase-design` — Boolean Control-Flow Mode Trap)

- **Pathology:** An internal function adds a `boolean` parameter (`function runSync(items: Item[], dryRun: boolean)`) that is used solely as a control-flow switch (`if (dryRun) { ... } else { ... }`) to select between two behaviors, and call sites pass mysterious positional boolean literals (`runSync(items, true)`).
- **Why ecosystem rules fail:** Naive bans on `boolean` parameters reject legitimate state/attribute setters (`setVisible(true)`, `setDisabled(false)`) where the boolean is stored as data rather than branching control flow.
- **Deterministic proof on the Call-Graph Verifier (`wrapping-functions.mjs`):**
  1. Inspect non-setter first-party functions with a positional `boolean` parameter `flag` (not inside an options object `{ dryRun?: boolean }`).
  2. Verify inside the function body that `flag` is **only referenced in branch conditions** (`if (flag)`, `flag ? ... : ...`, `!flag`) and is **never** assigned to a property/state/variable or passed as a data value to a sink.
  3. Verify across `program.getSourceFiles()` that **`>= 1` call site passes a bare boolean literal (`true` or `false`)** positionally for `flag`.
  4. Report the parameter: replace positional boolean mode flags with a named case/mode union or separate functions.

---

## 4. Third-Party Ecosystem Overlap Matrix (`anti-slop`, `ai-guard`, `slop`, `zero-tolerance`, `unicorn`, `you-might-not-need-an-effect`, `barrel-files`, `oxlint`, `biome`)

Each of the 17 rules above was audited against third-party AI-slop, guardrail, and architectural ESLint/Oxlint/Biome plugins (`dmmulroy/anti-slop`, `ai-guard-dev/eslint-plugin-ai-guard`, `antfu/eslint-plugin-slop`, `jantimon/eslint-plugin-no-comment-slop`, `@coderrob/eslint-plugin-zero-tolerance`, `thepassle/eslint-plugin-barrel-files`, `nickjvandyke/eslint-plugin-react-you-might-not-need-an-effect`, `eslint-plugin-functional`, `cartant/eslint-plugin-etc`, `danielnixon/eslint-plugin-total-functions`, `SonarSource/SonarJS`, `sindresorhus/eslint-plugin-unicorn`, and `@typescript-eslint/eslint-plugin`) to confirm we do not rebuild existing functionality.

| #    | Antidrift Rule                                                    | Closest Third-Party Rule(s)                                                                                                                                                          | Detector Mode                                | Why Existing Third-Party Rules Do Not Cover Our Invariant                                                                                                                                                                                                                                                                                                                                     |
| ---- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.1  | `no-case-table-type-annotation`                                   | `dmmulroy/anti-slop` `no-known-value-widening` (vendored into `antidrift/no-appeasement-erasure`); `@coderrob/eslint-plugin-zero-tolerance` `require-exported-object-type` (inverse) | Syntax-only (same-file AST alias table)      | Upstream `anti-slop` `main` explicitly allows finite-key `Record<ClosedUnion, V>` (`hasBroadRecordKey`), and vendored `6d53855` misses named mapped-type aliases (`type Table = { [K in keyof Cases]: ... }`) via `isBroadMappedKey` while false-positiving on mutable lookup caches.                                                                                                         |
| 2.2  | `no-inline-parse-reshape`                                         | None                                                                                                                                                                                 | N/A                                          | Zero third-party rules inspect schema decode call arguments (`schema.parse`, `v.parse`, `Schema.decodeUnknown*`) for single-source inline object reshaping.                                                                                                                                                                                                                                   |
| 2.3  | `no-source-file-read-in-test`                                     | `@coderrob/eslint-plugin-zero-tolerance` `no-fetch-in-tests` / `no-restricted-imports-in-tests`                                                                                      | Syntax-only                                  | No ecosystem rule tracks `readFileSync` / `readFile` / `Bun.file` of source-code extensions (`.ts`, `.tsx`, `.js`, etc.) flowing into `expect(...).toContain/toMatch`.                                                                                                                                                                                                                        |
| 2.4  | `no-bag-reshaper` (`bagToContract` & `bagToBag`, **implemented**) | `antfu/eslint-plugin-slop` `no-trivial-functions`; `@coderrob/eslint-plugin-zero-tolerance` `no-destructured-parameter-type-literal`                                                 | Syntax-only                                  | `slop/no-trivial-functions` only matches scalar `param.prop` or `callee(a, b)` forwarding on unexported functions with `< 5` local references; it never inspects returned `ObjectLiteralExpression`s (`return { ... }`) or `TypeChecker` parameter-bag and contract vs. bag return types.                                                                                                     |
| 2.5  | `no-test-only-seam`                                               | `sindresorhus/eslint-plugin-unicorn` `no-unnecessary-parameters` (`always-default`)                                                                                                  | Syntax-only (single-file local call tracker) | `unicorn/no-unnecessary-parameters` only checks unexported functions called `>= 2` times within the same file; it skips exported production functions, cannot partition test vs. production callers across `program.getSourceFiles()`, and cannot distinguish effectful runtime dependencies (`exec = execFileSync`, `now = Date.now`) from pure config defaults.                             |
| 2.6  | `no-single-adapter-seam`                                          | None                                                                                                                                                                                 | N/A                                          | Requires program-wide `ts.Program` symbol indexing across `implements`, `extends`, and `: Seam` / `satisfies Seam` object adapters.                                                                                                                                                                                                                                                           |
| 2.7  | `no-closed-string-parameter`                                      | `@coderrob/eslint-plugin-zero-tolerance` `no-magic-strings`                                                                                                                          | Syntax-only                                  | `no-magic-strings` bans all string literals in `===`/`switch` indiscriminately; no third-party rule detects a widened `string` parameter or field guarded by a throwing `!CLOSED_SET.includes(param)` / `param !== "a" && param !== "b"` check.                                                                                                                                               |
| 2.8  | `no-reexport-only-module`                                         | `unicorn/no-barrel-files`; `barrel-files/avoid-barrel-files`; `oxc/no-barrel-file`; `biome` `noBarrelFile`; `zero-tolerance/no-re-export`                                            | Syntax-only or module-graph count (`oxc`)    | `unicorn/no-barrel-files` checks the `Program.body` re-export-only shape (and can inform our AST check), but is `recommended: false` because it lacks `package.json` (`exports`/`main`/`module`/`bin`) entrypoint exemptions and `./_internal` private-sibling facade exemptions. `barrel-files` and `oxc` use export-count thresholds (`> 3` or `> 100`) that miss 1-symbol re-export shims. |
| 2.9  | `no-argument-mutation-side-effect`                                | `eslint` `no-param-reassign({ props: true })`; `functional/immutable-data`; `zero-tolerance/no-object-mutation`                                                                      | Syntax-only                                  | Ecosystem rules ban all property writes across all functions (including functions that return values, `(req, res)` middleware, DOM handlers, and class methods) and miss `Map.prototype.set`; none gates on `void`/`Promise<void>` return type + `TypeChecker` plain-bag/record/`Map` receiver type.                                                                                          |
| 2.10 | `no-direct-secret-cli-call`                                       | `@coderrob/eslint-plugin-zero-tolerance` `no-shell-command-construction`                                                                                                             | Syntax-only                                  | `no-shell-command-construction` only targets dynamic shell strings; no rule targets subprocess invocations of `secret-tool`, `op read` / `op item`, or `security find-generic-password`.                                                                                                                                                                                                      |
| 3.1  | `no-catch-error-text-branching`                                   | `ai-guard-dev/eslint-plugin-ai-guard` `no-broad-exception`                                                                                                                           | Syntax-only                                  | `no-broad-exception` only checks `catch (e: any)`; no rule inspects caught/thrown error types via `TypeChecker` for structured discriminants (`code`, `status`, `_tag`) or cross-module error prose matching.                                                                                                                                                                                 |
| 3.2  | `no-speculative-fallback-on-owned-contract`                       | `@typescript-eslint/no-unnecessary-condition`; `@typescript-eslint/no-useless-default-assignment`; `dmmulroy/anti-slop` `no-runtime-typeof`                                          | `TypeChecker` / Syntax-only                  | `no-unnecessary-condition` fires on `arr[i]` and `dict[k]` when `noUncheckedIndexedAccess` is off and ignores `typeof x.prop` / `Array.isArray(x.prop)` against schema provenance; `no-useless-default-assignment` only checks `=` in `AssignmentPattern`, never `base.prop ?? fallback`; `anti-slop/no-runtime-typeof` is syntax-only.                                                       |
| 3.3  | `no-shadow-state-mirror-in-react`                                 | `nickjvandyke/eslint-plugin-react-you-might-not-need-an-effect` `no-derived-state`                                                                                                   | Syntax + ESLint Scope                        | `no-derived-state` false-positives on resettable draft/form state when `setValue` is also called in an `onChange` event handler, misses dead `useState(props.value)` cells with 0 setter calls (no `useEffect`), and misses state synced from custom/query hooks (`useQuery().data`).                                                                                                         |
| 3.4  | `no-schema-field-restatement`                                     | `ai-guard-dev/eslint-plugin-ai-guard` `no-duplicate-logic-block`                                                                                                                     | Syntax-only                                  | `no-duplicate-logic-block` only compares adjacent identical statements in a block; no rule fingerprints runtime `z.object` / `v.object` / `Schema.Struct` property validator chains across modules.                                                                                                                                                                                           |
| 3.5  | `no-bag-of-optionals-discriminated-state`                         | None                                                                                                                                                                                 | N/A                                          | Requires cross-program consumer narrowing analysis (`if (x.status === "ready") { x.data! }`) to distinguish a flattened state machine from an orthogonal options bag.                                                                                                                                                                                                                         |
| 3.6  | `no-lossy-error-rethrow`                                          | `eslint` `preserve-caught-error`; `biome` `useErrorCause`; `ai-guard` `no-catch-log-rethrow`                                                                                         | Syntax-only                                  | `preserve-caught-error` and `useErrorCause` allow `throw new Error(err.message, { cause: err })` even when it adds zero context and strips the error class/prototype (`instanceof`, `.code`, `.status`), and miss `.catch(err => Promise.reject(new Error(err.message)))`.                                                                                                                    |
| 3.7  | `no-boolean-flag-mode-parameter`                                  | `@coderrob/eslint-plugin-zero-tolerance` `no-flag-argument`                                                                                                                          | Syntax-only (`TSBooleanKeyword`)             | `zero-tolerance/no-flag-argument` flags every `param: boolean` on every function (`setVisible(visible: boolean)`), whereas `antidrift/no-boolean-flag-mode-parameter` proves (a) `flag` is used solely in branch conditions inside the body AND (b) `>= 1` call site passes a bare positional `true`/`false` literal.                                                                         |

### 4.2 Impact of Ecosystem Learnings on the Wider Antidrift Ruleset

1. **Clean Seam Between `antidrift/no-appeasement-erasure` and `antidrift/no-case-table-type-annotation` (Directive G3):**
   - Updating [`dictionary-types.js`](file:///home/joedeleeuw/code/antidrift/tooling/antidrift/src/oxlint-plugin/anti-slop/shared/dictionary-types.js) with `hasBroadRecordKey` (ported from upstream `dmmulroy/anti-slop` `main`) ensures `antidrift/no-appeasement-erasure` only flags open-key dictionaries (`Record<string | number | symbol | PropertyKey, V>`, `{ [k: string]: V }`, `Map<string, unknown>`) and `unknown`/`object` widening.
   - `antidrift/no-case-table-type-annotation` then cleanly owns closed-key `Record<ClosedUnion, V>` and mapped-type annotations on immutable `const` object-literal case tables (resolving imported `type Table = { [K in keyof Cases]: ... }` aliases via `TypeChecker` and verifying zero write/mutation references), enforcing `satisfies Table` with zero rule overlap.
2. **Deepening Existing Rule Owners Instead of Spawning One-Off Rules (Directives G7, G10, G11):**
   - **Error Rethrow Hygiene (`antidrift/no-lossy-error-rethrow`):** Unifies `lossyErrorRethrow` (`throw new Error(err.message)`) and `catchLogRethrow` (`console.error(err); throw err;` / `logger.error(err); throw err;`, inspired by `ai-guard-dev/eslint-plugin-ai-guard`) under a single owner covering both `CatchClause` and `.catch(...)` promise handlers.
   - **Comment Hygiene (`antidrift/no-tutorial-comments`):** Extends [`no-tutorial-comments.js`](file:///home/joedeleeuw/code/antidrift/tooling/antidrift/src/oxlint-plugin/portable/no-tutorial-comments.js) with ASCII section-divider banner detection (`// ====================`, `// --- Helpers ---`, inspired by `jantimon/eslint-plugin-no-comment-slop` `no-banner-comment`) rather than adding a second comment-scanning rule.
3. **Replacing Syntax-Only Receiver/Tag Whitelists with `TypeChecker` & Schema Provenance:**
   - **O(N²) Accumulator Copy (`antidrift/no-reduce-accumulator-copy`):** Whereas upstream `dmmulroy/anti-slop` uses a syntax-only `isKnownArrayExpression` whitelist that misses `.reduce(...)` on typed array parameters (`items: readonly Item[]`) and typed function returns (`getRows().reduce(...)`), our implementation on `defineTypeScriptRule` checks `checker.isArrayType(receiverType) || checker.isTupleType(receiverType)` before flagging `Object.assign({}, acc, ...)`, `Array.from(acc)`, `acc.concat(...)`, and `acc.slice()`.
   - **Effect Tagged Construction (`effect-schema.mjs`):** Whereas upstream `anti-slop-effect/no-manual-tagged-construction` bans all `{ _tag: "..." }` object literals by syntax (false-positiving on plain TypeScript discriminated unions), `TypeChecker` + `effect-schema.mjs` proves the contextual/expected type originates from an Effect `Data.TaggedClass`, `Data.TaggedError`, `Schema.TaggedError`, or `Schema.TaggedStruct` declaration.
