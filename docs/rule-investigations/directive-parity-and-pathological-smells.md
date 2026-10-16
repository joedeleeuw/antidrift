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

### 2.1 `antidrift/no-case-table-type-annotation` (Directive G3)

- **Directive (`AGENT.md` § Type Safety):**
  > _"To index a case table by a generic key, declare `type Table = { [K in keyof Cases]: (value: Cases[K]) => Out }`, write `const TABLE = { ... } satisfies Table`, and read a row through a typed indexed access (`const row: Table[K] = TABLE[key]`). Do not annotate the binding with a mapped type or `Record`: that erases the table's evidence, and the antidrift lint rejects it."_
- **Current gap:** `antidrift/no-partial-record-satisfies` rejects `{ ... } satisfies Partial<Record<K, V>>`, and its `allows` example currently permits `const labels: Partial<Record<State, string>> = { ready: "Ready" }`. No rule rejects annotating a `const` case-table object literal with `: Record<ClosedKey, V>` or `: MappedTable`, which widens each property value type and erases per-key literal/function specialization.
- **Required context:** `defineTypeScriptRule` (`ts-rule-kernel.mjs`) — `sourceFile`, `checker`, and ESLint scope reference tracking (or AST write-reference scan).
- **Implementation specification:**
  1. Match `ts.SyntaxKind.VariableDeclaration` inside a `const` `VariableDeclarationList` where `initializer` (unwrapping `Object.freeze(...)`) is a non-empty `ObjectLiteralExpression` and `type` (the explicit `: T` annotation) is present.
  2. Resolve the declared type `T = checker.getTypeFromTypeNode(node.type)`.
  3. Determine whether `T` is a **closed case-table contract**:
     - `T` is an instantiation of `Record<K, V>` or `Readonly<Record<K, V>>` where `K` is a finite union of string/number/symbol literals (or a type parameter constrained to `keyof Cases` / a finite union), OR
     - `T`'s symbol declaration is a `MappedTypeNode` (`{ [K in ...]: ... }`) whose key space is a finite union or `keyof` a closed object/map (excluding `Partial<...>` / optional mapped types where keys are intentionally omitted, and excluding open index signatures `Record<string, V>`, `Record<number, V>`, `Record<PropertyKey, V>`).
  4. Verify that the variable binding is never reassigned and never mutated (`TABLE[k] = ...`, `delete TABLE[k]`) across its lexical scope. (Mutable lookup caches legitimately require `: Record<...>` or `: Partial<Record<...>>`.)
  5. Verify that every required key of `T` is present in the `ObjectLiteralExpression` (so replacing `: T` with `satisfies T` is type-valid).
  6. Report the `: T` annotation and instruct using `satisfies T` on the object literal instead.

### 2.2 `antidrift/no-inline-parse-reshape` (Directive G4)

- **Directive (`AGENT.md` § Parse at Boundaries):**
  > _"Never reshape a payload inline to satisfy a schema, as in `parse(x.kind === "ready" ? { kind: "ready" } : x)` or `parse({ text: e.text })`. Define a named decoder at the receiving adapter, built from the owner's contract shapes (for example `z.object(contractSchema.shape)` to drop extra native fields), and parse once."_
- **Current gap:** `no-redundant-zod-parse` flags re-parsing an already validated value; `no-identity-schema-transform` flags `.transform((x) => ({ ... }))` identity copies; `unknown-input-must-be-decoded` flags unvalidated boundary uses. None flags inline payload reshaping inside the argument of a schema parse call.
- **Required context:** `defineTypeScriptRule` (`ts-rule-kernel.mjs`) + Schema Provenance (`schema-provenance.mjs` and `effect-schema.mjs`).
- **Implementation specification:**
  1. Identify recognized schema parse/decode invocations across Zod (`schema.parse(arg)`, `schema.safeParse(arg)`, `schema.parseAsync(arg)`, `schema.safeParseAsync(arg)`), Valibot (`v.parse(schema, arg)`, `v.safeParse(schema, arg)`), Effect Schema (`Schema.decodeUnknown*(schema)(arg)`), and TypeBox (`Value.Decode(schema, arg)`, `Value.Parse(schema, arg)`).
  2. Inspect the payload argument `arg`:
     - **Case A (Inline projection object literal):** `arg` is an `ObjectLiteralExpression` with `>= 1` property assignments where every property value reads from the same source root binding `x` (e.g., `{ text: e.text }` or `{ ...e, kind: "ready" }`) and `x` is not a freshly constructed local builders/accumulators map.
     - **Case B (Inline conditional reshape):** `arg` is a `ConditionalExpression` (`x.kind === "ready" ? { kind: "ready" } : x`) where one branch is a source binding `x` (or member of `x`) and the other branch is an inline `ObjectLiteralExpression` reshaping `x`.
  3. **Clean controls (do not report):**
     - Assembling distinct independent arguments into a composite object (`Schema.parse({ body: rawBody, headers: rawHeaders })` where properties come from `>= 2` distinct source bindings).
     - Calls inside a schema's own `.preprocess(...)`, `.transform(...)`, or `Schema.transform(...)` combinator.

### 2.3 `antidrift/no-source-file-read-in-test` (Directive G15)

- **Directive (`AGENT.md` § Testing & `~/code/AGENTS.md` § Smoke-First Validation):**
  > _"Avoid contract/guard tests that `readFileSync` a source module and assert it `.toContain("someCode")` / matches a code shape: they prove nothing about behavior, break on every refactor, and are treated as noise. Don't write them; remove them when found."_
- **Current gap:** `antidrift/no-repo-state-mirror-assertion` only checks tests that _import_ configured repo-owned state modules, and is inert unless configured. Source-string contract tests read source files from disk with `readFileSync` / `readFile` / `Bun.file`.
- **Required context:** Oxlint / portable AST + local variable taint within a test file (`*.test.*`, `*.spec.*`, `**/__tests__/**`).
- **Implementation specification:**
  1. Restrict to test files (`isTestFile(filename)`).
  2. Track calls to `readFileSync`, `readFile`, `fs.readFileSync`, `fs.promises.readFile`, `fsPromises.readFile`, or `Bun.file(...).text()` whose path argument (literal, template literal, `path.join(...)`, `path.resolve(...)`, or `new URL(..., import.meta.url)`) ends with a source-code extension (`.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.py`, `.go`, `.rs`, `.css`) and does **not** point into a fixture/snapshot/artifact path (`fixtures`, `__fixtures__`, `__snapshots__`, `testdata`, `dist`, `build`).
  3. Follow the returned string (or `await`ed string) directly or through a local `const`/`let` binding into `expect(actual).<matcher>(...)` where `<matcher>` is a string/regex/snapshot assertion (`toContain`, `toMatch`, `toBe`, `toEqual`, `toMatchSnapshot`, `toMatchInlineSnapshot`).
  4. Report the assertion as a source-shape guard test that must be deleted or replaced with behavioral execution.

### 2.4 `antidrift/no-test-only-seam` (Directive G11 — `test_only_seams` Parity)

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

### 2.5 `antidrift/no-single-adapter-seam` (Directive G11 — `single_adapter_seams` Parity)

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

### 2.6 `antidrift/no-closed-string-parameter` (Directive G9 — `g9-closed-string` Parity)

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

### 2.7 `antidrift/no-reexport-only-module` (Directive G10 — `g10-reexport-module` Parity)

- **Directive (`AGENT.md` § Code Design & `dotfiles/config/code-health/rules/g10-reexport-module.yml`):**
  > _"A function whose body is one call is a hop, not an owner; delete it and let the caller name the owner. The same goes for a module that re-exports one symbol... A split moves code and updates every importer in the same commit: no re-export shims."_
  > In `dotfiles`, `g10-reexport-module` scored **15/17 (88% precision)** across 8 repositories.
- **Current gap:** Antidrift enforces `no-wrapping-functions` for function hops, but has no rule for barrel/shim modules whose only statements re-export symbols from other modules.
- **Required context:** Oxlint / portable AST + package entrypoint resolution (`package.json` `exports` / `main` / `bin`).
- **Implementation specification:**
  1. Inspect `Program.body` in non-test, non-`.d.ts`, non-generated files.
  2. Ignore files declared as public package entrypoints in the enclosing `package.json` (`exports`, `main`, `module`, `bin`) and public facade files that only re-export from an underscore-prefixed private sibling (`export * from "./_internal"`).
  3. Report the module when `Program.body` is non-empty and every statement is an `ExportNamedDeclaration` with `source !== null` (`export { a } from "./b"`), an `ExportAllDeclaration` (`export * from "./b"`), or an `ImportDeclaration` whose bindings are only used in `export { a }`.

### 2.8 `antidrift/no-argument-mutation-side-effect` (Directive D2 — `d2-dict-argument-write` Parity)

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

### 2.9 `antidrift/no-direct-secret-cli-call` (Directive G18 — `g18-secret-call` Parity)

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

### 3.6 `antidrift/no-lossy-error-rethrow` (Directive G7 — Catch-and-Rethrow That Strips Error Identity)

- **Pathology:** Inside `catch (err)`, code writes `throw new Error(err instanceof Error ? err.message : String(err))` or `throw new Error(\`Failed: \${err.message}\`)`without`{ cause: err }` or without adding a typed domain error class (`RequestError`, `ValidationError`). Even when `preserve-caught-error`is satisfied or bypassed, re-wrapping a caught error into a bare`new Error(err.message)` destroys the original prototype (`instanceof`), custom fields (`code`, `status`), and stack frame origin.
- **Why `preserve-caught-error` is insufficient:** Native `preserve-caught-error` only checks whether `{ cause }` is passed when a new `Error` is thrown; it allows `throw new Error(err.message, { cause: err })` in a catch block that adds zero context and strips the typed error class, and misses `.catch((err) => Promise.reject(new Error(err.message)))`.
- **Deterministic proof (Oxlint / AST + Scope):**
  1. Inside a `catch (err)` clause or `.catch((err) => ...)` handler whose only side effect is throwing/rejecting:
  2. Report when the thrown expression is a bare `new Error(...)` (not a custom error subclass or domain error constructor) whose message argument is solely `err.message`, `String(err)`, or `` `${err}` `` / `` `${err.message}` `` (with no added context interpolation or structured error class).

### 3.7 `antidrift/no-boolean-flag-mode-parameter` (Directive G9 / `codebase-design` — Boolean Control-Flow Mode Trap)

- **Pathology:** An internal function adds a `boolean` parameter (`function runSync(items: Item[], dryRun: boolean)`) that is used solely as a control-flow switch (`if (dryRun) { ... } else { ... }`) to select between two behaviors, and call sites pass mysterious positional boolean literals (`runSync(items, true)`).
- **Why ecosystem rules fail:** Naive bans on `boolean` parameters reject legitimate state/attribute setters (`setVisible(true)`, `setDisabled(false)`) where the boolean is stored as data rather than branching control flow.
- **Deterministic proof on the Call-Graph Verifier (`wrapping-functions.mjs`):**
  1. Inspect non-setter first-party functions with a positional `boolean` parameter `flag` (not inside an options object `{ dryRun?: boolean }`).
  2. Verify inside the function body that `flag` is **only referenced in branch conditions** (`if (flag)`, `flag ? ... : ...`, `!flag`) and is **never** assigned to a property/state/variable or passed as a data value to a sink.
  3. Verify across `program.getSourceFiles()` that **`>= 1` call site passes a bare boolean literal (`true` or `false`)** positionally for `flag`.
  4. Report the parameter: replace positional boolean mode flags with a named case/mode union or separate functions.
