import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import tsParser from "@typescript-eslint/parser";
import { RuleTester } from "eslint";
import { afterAll, describe, it } from "vitest";

import plugin from "./index.js";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "fixtures");

function fixture(relativePath) {
  const fullPath = resolve(fixturesDir, relativePath);
  return { code: readFileSync(fullPath, "utf8"), filename: fullPath };
}

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    ecmaVersion: 2023,
    sourceType: "module",
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

// Type-aware tester: uses real firebase + zod types via the fixtures tsconfig.
// The rule enumerates canonical types from the program (which loads firebase because a
// sibling fixture imports it), so no settings/index plumbing is needed.
const typedRuleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: {
      projectService: {
        allowDefaultProject: ["*.ts"],
        defaultProject: resolve(fixturesDir, "tsconfig.json"),
      },
      tsconfigRootDir: fixturesDir,
    },
  },
});

const typeServiceMessage = /requires TypeScript parser services/u;
const rule = (name) => plugin.rules[name];
const typeServiceGuardedRules = [
  "no-appeasement-cast",
  "no-canonical-model-fork",
  "no-defensive-shape-probing",
  "no-redundant-zod-parse",
  "no-structural-type-fork",
  "no-underchecked-type-predicate",
  "no-unsafe-deserialize",
];

for (const guardedRule of typeServiceGuardedRules) {
  ruleTester.run(`${guardedRule} type-service guard`, rule(guardedRule), {
    valid: [],
    invalid: [
      {
        code: "declare const value: any; value;",
        errors: [{ message: typeServiceMessage }],
      },
    ],
  });
}

ruleTester.run("no-async-array-method", rule("no-async-array-method"), {
  valid: [
    fixture("programs/correct/async-map-promise-all.ts"),
    fixture("programs/correct/async-map-delayed-promise-all.ts"),
    "items.map((i) => i + 1);",
    "async function f() { for (const i of items) { await work(i); } }",
  ],
  invalid: [
    { ...fixture("programs/drift/async-map-without-promise-all.ts"), errors: 1 },
    { ...fixture("programs/drift/async-foreach-callback.ts"), errors: 1 },
    { ...fixture("programs/drift/async-filter-callback.ts"), errors: 1 },
  ],
});

ruleTester.run("require-effect-deps", rule("require-effect-deps"), {
  valid: [
    fixture("programs/correct/effect-empty-deps.ts"),
    fixture("programs/correct/effect-with-deps.ts"),
    'import { useLayoutEffect } from "react"; useLayoutEffect(() => {}, []);',
    'import { useEffect as ue } from "react"; ue(() => {}, [x]);',
    'import React from "react"; React.useEffect(() => {}, [x]);',
    'import * as React from "react"; React.useEffect(() => {}, [x]);',
    // Different react hook — not an effect hook
    'import { useState } from "react"; useState(0);',
    // Not imported from react — out of scope, do not flag
    "useEffect(() => {});",
    // useEffect from a non-react module is not the React hook
    'import { useEffect } from "./mine"; useEffect(() => {});',
  ],
  invalid: [
    { ...fixture("programs/drift/effect-missing-deps-direct.ts"), errors: 1 },
    { code: 'import { useLayoutEffect } from "react"; useLayoutEffect(() => {});', errors: 1 },
    { code: 'import { useEffect as ue } from "react"; ue(() => {});', errors: 1 },
    { code: 'import React from "react"; React.useEffect(() => {});', errors: 1 },
    { code: 'import * as React from "react"; React.useEffect(() => {});', errors: 1 },
    { ...fixture("programs/drift/effect-missing-deps.ts"), errors: 1 },
  ],
});

ruleTester.run("no-trivial-selector-wrapper", rule("no-trivial-selector-wrapper"), {
  valid: [
    fixture("programs/correct/exported-function-selector-boundary.ts"),
    fixture("programs/correct/selector-computation.ts"),
    fixture("programs/correct/inferred-selector-wrapper.ts"),
    fixture("programs/correct/selector-returns-foreign-object.ts"),
    fixture("programs/correct/selector-this-member.ts"),
    fixture("programs/correct/destructured-param-computation.ts"),
    // Public methods of an exported class are a boundary; type-level/abstract signatures need explicit types
    fixture("programs/correct/methods-public-boundary.ts"),
    fixture("programs/correct/methods-interface-and-abstract.ts"),
    fixture("programs/correct/exported-object-boundary.ts"),
    fixture("programs/correct/returned-object-boundary.ts"),
    fixture("programs/correct/private-boolean-predicate-helper.ts"),
  ],
  invalid: [
    { ...fixture("programs/drift/typed-selector-wrapper.ts"), errors: 1 },
    { ...fixture("programs/drift/typed-selector-arrow-wrapper.ts"), errors: 1 },
    { ...fixture("programs/drift/typed-nested-selector-wrapper.ts"), errors: 1 },
    // Same wrapper as a method on an internal class must be caught too
    { ...fixture("programs/drift/methods-internal-appeasement.ts"), errors: 3 },
    { ...fixture("programs/drift/object-literal-appeasement.ts"), errors: 1 },
    { ...fixture("programs/drift/destructured-param-selector-wrapper.ts"), errors: 2 },
  ],
});

typedRuleTester.run("no-appeasement-cast", rule("no-appeasement-cast"), {
  valid: [
    fixture("programs/correct/narrow-then-assign.ts"),
    fixture("programs/correct/plain-cast.ts"),
    fixture("programs/correct/brand-validation-boundary.ts"),
    fixture("programs/correct/json-parse-result-schema-parse.ts"),
  ],
  invalid: [
    { ...fixture("programs/drift/appeasement-cast.ts"), errors: 2 },
    { ...fixture("programs/drift/json-parse-result-cast.ts"), errors: 1 },
  ],
});

typedRuleTester.run("no-defensive-shape-probing", rule("no-defensive-shape-probing"), {
  valid: [
    fixture("programs/correct/owned-type-guard-or-schema.ts"),
    fixture("programs/correct/narrow-then-assign.ts"),
  ],
  invalid: [
    { ...fixture("programs/drift/object-entries-shape-probing.ts"), errors: 1 },
  ],
});

ruleTester.run("no-coupled-state-setters", rule("no-coupled-state-setters"), {
  valid: [
    fixture("programs/correct/single-state-setter-handler.ts"),
    fixture("programs/correct/sibling-component-setter-scope.ts"),
  ],
  invalid: [
    { ...fixture("programs/drift/coupled-state-setters-handler.ts"), errors: 1 },
  ],
});

ruleTester.run("no-status-triplet-state", rule("no-status-triplet-state"), {
  valid: [
    fixture("programs/correct/resource-state-union.ts"),
  ],
  invalid: [
    { ...fixture("programs/drift/status-triplet-default.ts"), errors: 1 },
    {
      ...fixture("programs/drift/status-triplet-configured.ts"),
      options: [{ dataNames: ["rows"], loadingNames: ["busy"], errorNames: ["failure"] }],
      errors: 1,
    },
  ],
});

ruleTester.run("no-inline-structural-type-at-use-site", rule("no-inline-structural-type-at-use-site"), {
  valid: [
    fixture("programs/correct/named-structural-parameter-type.ts"),
    "import type { ReactNode } from 'react';\nexport function Shell({ children }: { children: ReactNode }) { return children; }",
    "type Props = { onConfirm: (date: { year: number; month: number; day: number }) => void }; void ({} as Props);",
    "const formatDate = (date: { year: number; month: number; day: number }) => String(date.year); void formatDate;",
  ],
  invalid: [
    { ...fixture("programs/drift/inline-structural-parameter-type.ts"), errors: 1 },
    {
      code: "export const createApi = () => ({ saveUser: async (req: { id: string; email: string }) => req.email });",
      errors: 1,
    },
  ],
});

ruleTester.run("no-raw-tailwind-color", rule("no-raw-tailwind-color"), {
  valid: [fixture("programs/correct/semantic-tailwind-token.tsx")],
  invalid: [{ ...fixture("programs/drift/raw-tailwind-color-class.tsx"), errors: 1 }],
});

ruleTester.run("no-hover-translate-card", rule("no-hover-translate-card"), {
  valid: [fixture("programs/correct/hover-shadow-card.tsx")],
  invalid: [{ ...fixture("programs/drift/hover-translate-card.tsx"), errors: 1 }],
});

ruleTester.run("no-raw-fetch-in-component", rule("no-raw-fetch-in-component"), {
  valid: [fixture("programs/correct/raw-fetch-in-helper.ts")],
  invalid: [
    { ...fixture("programs/drift/raw-fetch-in-component.tsx"), errors: 1 },
    { ...fixture("programs/drift/raw-fetch-in-component-module-helper.tsx"), errors: 1 },
  ],
});

ruleTester.run("no-sql-string-concat", rule("no-sql-string-concat"), {
  valid: [
    fixture("programs/correct/static-parameterized-sql-template.ts"),
    "const msg = `generated from ${source}`;",
    fixture("programs/correct/parameterized-sql-query.ts"),
  ],
  invalid: [
    { ...fixture("programs/drift/sql-template-interpolation.ts"), errors: 1 },
    { ...fixture("programs/drift/sql-string-concat.ts"), errors: 1 },
  ],
});

typedRuleTester.run("no-unsafe-deserialize", rule("no-unsafe-deserialize"), {
  valid: [
    fixture("programs/correct/json-parse-string.ts"),
    fixture("programs/correct/schema-parse-unknown.ts"),
  ],
  invalid: [
    { ...fixture("programs/drift/json-parse-unknown.ts"), errors: 1 },
    { ...fixture("programs/drift/json-parse-any.ts"), errors: 1 },
  ],
});

const statusOptions = { statuses: {
  UserStatus: { owner: "packages/domain/src/user.ts", values: ["active", "disabled", "invited"] },
}};

ruleTester.run("no-status-literal-in-type", rule("no-status-literal-in-type"), {
  valid: [
    { ...fixture("programs/correct/packages/domain/src/user.ts"), options: [statusOptions] },
    { code: "const x = user.status === 'active';", filename: "/repo/apps/web/src/App.ts", options: [statusOptions] },
    { code: "type BadgeProps = { variant: 'active' | 'disabled' };", filename: "/repo/apps/web/src/Badge.ts", options: [statusOptions] },
  ],
  invalid: [
    { ...fixture("programs/drift/status-literal-type-fork.ts"), options: [statusOptions], errors: 2 },
  ],
});

ruleTester.run("require-authz-check", rule("require-authz-check"), {
  valid: [
    fixture("programs/correct/authz-before-params.ts"),
    "function handler(req) { const body = req.body; return body; }",
    // Bug regression: outer authorize should NOT suppress a violation in an inner callback that
    // accesses params without its own authorize call. Before the fix, sawAuthz was set on ALL
    // frames, so the inner callback got credit for the outer function's authorize call.
    "function outer(req) { authorize(req.user); }",
  ],
  invalid: [
    { ...fixture("programs/drift/params-without-authz.ts"), errors: 1 },
    // Regression case: outer authorize must not suppress inner violation.
    { ...fixture("programs/drift/nested-params-without-local-authz.ts"), errors: 1 },
  ],
});

// ─── no-structural-type-fork fixture suite ────────────────────────────────────
// Uses real firebase + zod devDependencies via fixtures/tsconfig.json.
// Valid cases pass now (rule is a stub). Invalid cases are red until implementation lands.
// Each fixture file documents its expected behaviour in its leading comment.

typedRuleTester.run("no-structural-type-fork", rule("no-structural-type-fork"), {
  valid: [
    // Imports firebase types directly — no local redeclaration
    fixture("programs/correct/single-import.ts"),
    // Extends via intersection — adds fields, doesn't restate shape
    fixture("programs/correct/extends-intersection.ts"),
    // Discriminated union composition — firebase type as a variant
    fixture("programs/correct/union-composition.ts"),
    // Zod wraps the imported type via z.custom — no shape restatement
    fixture("programs/correct/zod-wraps-import.ts"),
    // Barrel re-export — not a redeclaration
    fixture("programs/correct/barrel-reexport.ts"),
    // Multi-file: canonical types file extends correctly
    fixture("programs/correct/multi-file/domain-types.ts"),
    // Multi-file: consumer imports from canonical types file
    fixture("programs/correct/multi-file/consumer.ts"),
    // Edge: below minimum field threshold — not enough overlap to flag
    fixture("programs/edge/below-threshold.ts"),
    // Edge: same field names but wrong types — structural mismatch, must not fire
    // (validates that the rule checks types, not just names)
    fixture("programs/edge/wrong-field-types.ts"),
    // Pure alias of an imported type — resolves to the package's own symbol, not a fork
    fixture("programs/correct/alias-of-import.ts"),
    // Generic container — property types reference the type parameter, matches nothing concrete
    fixture("programs/correct/generic-wrapper.ts"),
  ],
  invalid: [
    // Full structural redeclaration — no import from firebase
    { ...fixture("programs/drift/redeclares-full.ts"), errors: 1 },
    // Same shape, different name — classic agent drift
    { ...fixture("programs/drift/redeclares-named-differently.ts"), errors: 1 },
    // Zod schema whose inferred type mirrors firebase UserInfo
    { ...fixture("programs/drift/zod-schema-mirror.ts"), errors: 1 },
    // Correct extension in the same file plus a redeclaration elsewhere in the same file
    { ...fixture("programs/drift/extends-and-redeclares.ts"), errors: 1 },
    // Multi-file: correct import in one file must not suppress drift error in sibling file
    { ...fixture("programs/drift/multi-file/drift-elsewhere.ts"), errors: 1 },
    // Edge: 4-field subset with correct types — above threshold, should fire
    { ...fixture("programs/edge/partial-subset.ts"), errors: 1 },
    // Loosened redeclaration — all fields optional, still a structural fork
    { ...fixture("programs/drift/redeclares-optional.ts"), errors: 1 },
  ],
});

// ─── no-redundant-zod-parse fixture suite ─────────────────────────────────────
// Provenance-based: fires only when a value produced by `S.parse()` is re-parsed by the same S.
typedRuleTester.run("no-redundant-zod-parse", rule("no-redundant-zod-parse"), {
  valid: [
    // Boundary parse of raw/any input — the legitimate first validation
    fixture("programs/correct/zod-boundary-parse.ts"),
    // Different schema for the storage shape — a genuine second validation, not redundant
    fixture("programs/correct/zod-different-schema-reparse.ts"),
    // Double JSON.parse — not Zod, must stay silent (confirms the zod guard)
    fixture("programs/correct/zod-non-zod-parse.ts"),
    // Typed param re-parse — no local provenance, so Rule A correctly abstains (Rule C's case)
    fixture("programs/drift/zod-reparse-typed-value.ts"),
  ],
  invalid: [
    // Re-parse of a parsed value in the same function
    { ...fixture("programs/drift/zod-reparse-same-fn.ts"), errors: 1 },
    // Re-parse across functions in the same file via a module-scoped validated const
    { ...fixture("programs/drift/zod-reparse-cross-fn-same-file.ts"), errors: 1 },
    // Re-parse of a service/helper result already typed as the schema output
    { ...fixture("programs/drift/zod-reparse-service-result.ts"), errors: 1 },
  ],
});
