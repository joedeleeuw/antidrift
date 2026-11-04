# @joedeleeuw/antidrift

Host-agnostic Oxlint and ESLint rules for TypeScript, React, boundary decoding, and AI-agent drift prevention.

Every rule is authored against standard `ESTree` + `sourceCode` + `ScopeManager` (`create(context)`), with **zero runtime dependencies**, so the exact same plugin runs natively in both **Oxlint** (`jsPlugins`) and **ESLint v9/v10** (`plugins: { antidrift }`).

## Exports

- `@joedeleeuw/antidrift`: `{ antidriftPlugin, rules, recommendedRules, oxlintPreset, createOxlintConfig, eslintPreset, createEslintConfig }` (default export: `antidriftPlugin`)
- `@joedeleeuw/antidrift/oxlint-plugin` / `@joedeleeuw/antidrift/eslint-plugin`: `antidriftPlugin` (`meta.name: "antidrift"`, `rules`)
- `@joedeleeuw/antidrift/oxlint-config` / `@joedeleeuw/antidrift/preset`: `{ oxlintPreset, createOxlintConfig, recommendedRules }`
- `@joedeleeuw/antidrift/eslint-config`: `{ eslintPreset, createEslintConfig, recommendedRules }`

## Usage with Oxlint

```ts
import { createOxlintConfig } from "@joedeleeuw/antidrift/oxlint-config";
import { defineConfig } from "oxlint";

const antidrift = createOxlintConfig();

export default defineConfig({
  jsPlugins: [...antidrift.jsPlugins],
  rules: {
    ...antidrift.rules,
  },
});
```

## Usage with ESLint (Flat Config)

```js
import { createEslintConfig } from "@joedeleeuw/antidrift/eslint-config";

export default [
  createEslintConfig({
    files: ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"],
  }),
];
```

### Progressive type information

Every rule runs on syntax and scope alone. When the ESLint parser also exposes `parserServices.program` (typescript-eslint with `projectService: true` or `project`), the schema rules additionally resolve runtime-schema provenance through the TypeChecker: a receiver whose type or symbol is declared by a runtime-schema package (`zod`, `valibot`, `effect/Schema`, ...) is proven even when the schema is imported from project code, and a receiver the checker cannot trace to such a package is treated as a plain value instead of falling back to name heuristics. `no-unformatted-number` likewise skips JSX expressions whose resolved type is a string.

`optional-input-earns-optionality` is the one rule that needs the program: it resolves every call site of a component or exported function through the TypeChecker and reports an optional prop or parameter that no caller passes (delete it) or that every caller passes (make it required). A verdict requires a provably complete call-site set, so it abstains on spread props or arguments; references that escape a direct call or JSX element; default exports and `as default` re-exports; symbols reachable from a `package.json` entry (`exports`, `main`, `types`, mapped back through `rootDir`/`outDir` or a declaration entry), and every export of a package whose entries cannot be mapped to program source; modules whose namespace escapes (`export * as`, `import * as` used as a value or with a dynamic key, `import()`/`require()` results not immediately member-accessed); a nonliteral argument that does not prove supply through a required property; methods of subclassed classes or ones reachable through another assignable receiver type; props types shared outside the parameter; and declarations with no call site. Full coverage comes from typed ESLint (`projectService: true` or `project`); in Oxlint and untyped ESLint it reports nothing. Call sites in files outside the linted file's TypeScript program are not seen, so declarations reachable from another program must be exported through a package entry.

## Development

```bash
pnpm install
pnpm check       # tsc + oxlint self-lint + Oxlint/ESLint/tarball runtime smoke
```

### Writing a rule

Every rule is a plain `{ meta, create(context) }` module under `src/oxlint-plugin/` and must run unchanged in both hosts:

- Use `ESTree` nodes (including `.parent` links), `context.sourceCode`, and `context.sourceCode.getScope(node)`. Never import `@oxlint/plugins` runtime wrappers or ESLint-only APIs.
- Accept `files` and `excludeFiles` in `meta.schema` and gate `create` with `isRuleFile(context)` from `src/oxlint-plugin/shared/rule-scope.js`.
- Reuse the shared helpers before adding new ones: expression unwrapping, variable and const-initializer lookup live in `src/oxlint-plugin/shared/scope.js`; ESTree and JSX node helpers live in `src/oxlint-plugin/portable/ast.js`.
- Register the rule in `src/oxlint-plugin/index.js`; `pnpm check` verifies that every rule loads in Oxlint, ESLint, typed ESLint, and the packed tarball.

### What belongs here

- **Antidrift**: boundary, lexical, and AST invariants such as undecoded boundary input, appeasement casts, structural type forks, React render and state hygiene, test-oracle independence, and agent-drift smells.
- **`tsc` and `oxlint --type-aware`**: type-system invariants such as assignability, exhaustiveness, unsafe `any` flow, and floating promises.
- **`fallow`**: cross-file graph invariants such as unused exports, circular dependencies, and whole-repository duplication.
