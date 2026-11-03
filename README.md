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

## Development

```bash
pnpm install
pnpm check       # tsc + oxlint self-lint + Oxlint/ESLint/tarball runtime smoke
```
