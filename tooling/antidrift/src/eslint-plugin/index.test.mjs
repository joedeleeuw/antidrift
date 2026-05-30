import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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

const rule = (name) => plugin.rules[name];

ruleTester.run("no-async-array-method", rule("no-async-array-method"), {
  valid: [
    "async function f() { await Promise.all(items.map(async (i) => i + 1)); }",
    "items.map((i) => i + 1);",
    "async function f() { for (const i of items) { await work(i); } }",
  ],
  invalid: [
    { code: "items.map(async (i) => i + 1);", errors: 1 },
    { code: "items.forEach(async (i) => { await work(i); });", errors: 1 },
    { code: "items.filter(async (i) => i > 0);", errors: 1 },
  ],
});

ruleTester.run("require-effect-deps", rule("require-effect-deps"), {
  valid: [
    'import { useEffect } from "react"; useEffect(() => {}, []);',
    'import { useEffect } from "react"; useEffect(() => { f(x); }, [x]);',
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
    { code: 'import { useEffect } from "react"; useEffect(() => { f(x); });', errors: 1 },
    { code: 'import { useLayoutEffect } from "react"; useLayoutEffect(() => {});', errors: 1 },
    { code: 'import { useEffect as ue } from "react"; ue(() => {});', errors: 1 },
    { code: 'import React from "react"; React.useEffect(() => {});', errors: 1 },
    { code: 'import * as React from "react"; React.useEffect(() => {});', errors: 1 },
  ],
});

ruleTester.run("no-obvious-comment", rule("no-obvious-comment"), {
  valid: [
    "// Guard against null tenants before lookup\nconst t = ctx.tenant;",
    "const x = 1;",
    "// eslint-disable-next-line no-console\nconst y = 2;",
  ],
  invalid: [
    { code: "// increment count\ncount++;", errors: 1 },
    { code: "// set count to zero\nlet count = 0;", errors: 1 },
  ],
});

ruleTester.run("no-trivial-selector-wrapper", rule("no-trivial-selector-wrapper"), {
  valid: [
    "export function getPointFromBag(bag: { point: number }): number { return bag.point; }",
    "function compute(bag: { point: number }): number { return bag.point * 2; }",
  ],
  invalid: [
    { code: "function getPointFromBag(bag: { point: number }): number { return bag.point; }", errors: 1 },
  ],
});

ruleTester.run("no-unsafe-cast-chain", rule("no-unsafe-cast-chain"), {
  valid: ["const x = y as Foo;"],
  invalid: [{ code: "const x = y as unknown as Foo;", errors: 1 }],
});

ruleTester.run("no-silent-catch", rule("no-silent-catch"), {
  valid: ["try { f(); } catch (e) { throw e; }"],
  invalid: [
    { code: "try { f(); } catch (e) {}", errors: 1 },
    { code: "try { f(); } catch (e) { console.log(e); }", errors: 1 },
  ],
});

ruleTester.run("no-inline-disable-without-ticket", rule("no-inline-disable-without-ticket"), {
  valid: ["// @ts-ignore because the upstream SDK types are wrong\nconst x = 1;"],
  invalid: [{ code: "// @ts-ignore\nconst x = 1;", errors: 1 }],
});

ruleTester.run("no-coupled-state-setters", rule("no-coupled-state-setters"), {
  valid: [
    "function f() { const [a, setA] = useState(0); function h() { setA(1); } }",
    // Bug regression: ComponentB's handler calls only its OWN setter + a sibling's. Should not fire
    // because ComponentA's setX is no longer in scope after ComponentA exits.
    "function A() { const [x, setX] = useState(0); function h() { setX(1); } } function B() { const [y, setY] = useState(0); function h() { setY(1); } }",
  ],
  invalid: [
    {
      code: "function f() { const [a, setA] = useState(0); const [b, setB] = useState(0); const [c, setC] = useState(0); function h() { setA(1); setB(2); setC(3); } }",
      errors: 1,
    },
  ],
});

ruleTester.run("no-status-triplet-state", rule("no-status-triplet-state"), {
  valid: ["function f() { const [data, setData] = useState(null); }"],
  invalid: [
    {
      code: "function f() { const [data, setData] = useState(null); const [loading, setLoading] = useState(false); const [error, setError] = useState(null); }",
      errors: 1,
    },
  ],
});

ruleTester.run("no-explicit-return-type-private-helper", rule("no-explicit-return-type-private-helper"), {
  valid: [
    "export function helper(): number { return 1; }",
    "function useThing(): number { return 1; }",
  ],
  invalid: [{ code: "function helper(): number { return 1; }", errors: 1 }],
});

ruleTester.run("no-inline-structural-type-at-use-site", rule("no-inline-structural-type-at-use-site"), {
  valid: ["type T = { a: number }; function f(x: T): void {}"],
  invalid: [{ code: "function f(x: { a: number }): void {}", errors: 1 }],
});

ruleTester.run("no-raw-tailwind-color", rule("no-raw-tailwind-color"), {
  valid: ['const x = <div className="text-primary" />;'],
  invalid: [{ code: 'const x = <div className="text-red-500" />;', errors: 1 }],
});

ruleTester.run("no-hover-translate-card", rule("no-hover-translate-card"), {
  valid: ['const x = <div className="hover:shadow-lg" />;'],
  invalid: [{ code: 'const x = <div className="hover:-translate-y-1" />;', errors: 1 }],
});

ruleTester.run("no-raw-fetch-in-component", rule("no-raw-fetch-in-component"), {
  valid: ["function helper() { fetch('/api'); }"],
  invalid: [
    { code: "function Component() { fetch('/api'); return <div />; }", errors: 1 },
  ],
});


ruleTester.run("no-sql-string-concat", rule("no-sql-string-concat"), {
  valid: [
    "const q = `SELECT * FROM users WHERE id = ?`;",
    "const msg = `generated from ${source}`;",
    "db.query('SELECT * FROM users WHERE id = $1', [id]);",
  ],
  invalid: [
    { code: "const q = `SELECT * FROM users WHERE id = ${id}`;", errors: 1 },
    { code: 'const q = "DELETE FROM users WHERE id = " + id;', errors: 1 },
  ],
});

ruleTester.run("no-unsafe-deserialize", rule("no-unsafe-deserialize"), {
  valid: [
    "const data = JSON.parse(readFileSync(0, 'utf8'));",
    "const data = schema.parse(req.body);",
  ],
  invalid: [
    { code: "const data = JSON.parse(req.body);", errors: 1 },
    { code: "const data = JSON.parse(request.body.payload);", errors: 1 },
  ],
});

const gatewayOptions = { gateways: {
  ai: { wrapper: "packages/gateways/src/aiGateway.ts", bannedDirectImports: ["openai", "@anthropic-ai/sdk"] },
  cloud: { wrapper: "packages/gateways/src/cloudGateway.ts", bannedDirectImports: ["@aws-sdk/**"] },
}};

ruleTester.run("no-sdk-direct-use", rule("no-sdk-direct-use"), {
  valid: [
    { code: "import x from 'react';", options: [gatewayOptions] },
    { code: "import { completeText } from './aiGateway.js';", options: [gatewayOptions] },
    { code: "import OpenAI from 'openai';", filename: "/repo/packages/gateways/src/aiGateway.ts", options: [gatewayOptions] },
  ],
  invalid: [
    { code: "import OpenAI from 'openai';", filename: "/repo/apps/web/src/api.ts", options: [gatewayOptions], errors: 1 },
    { code: "import { S3 } from '@aws-sdk/client-s3';", filename: "/repo/apps/web/src/api.ts", options: [gatewayOptions], errors: 1 },
  ],
});

const statusOptions = { statuses: {
  UserStatus: { owner: "packages/domain/src/user.ts", values: ["active", "disabled", "invited"] },
}};

ruleTester.run("no-status-literal-in-type", rule("no-status-literal-in-type"), {
  valid: [
    { code: "type S = 'active' | 'disabled';", filename: "/repo/packages/domain/src/user.ts", options: [statusOptions] },
    { code: "const x = user.status === 'active';", filename: "/repo/apps/web/src/App.ts", options: [statusOptions] },
  ],
  invalid: [
    { code: "type MyStatus = 'active' | 'disabled';", filename: "/repo/apps/web/src/App.ts", options: [statusOptions], errors: 2 },
  ],
});

const roleOptions = { roles: { owner: "packages/domain/src/auth.ts", values: ["admin", "owner", "member"] }};

ruleTester.run("no-role-literal-in-type", rule("no-role-literal-in-type"), {
  valid: [
    { code: "type R = 'admin' | 'owner';", filename: "/repo/packages/domain/src/auth.ts", options: [roleOptions] },
    { code: "if (user.role === 'admin') {}",  filename: "/repo/apps/web/src/App.ts", options: [roleOptions] },
  ],
  invalid: [
    { code: "type AppRole = 'admin' | 'owner';", filename: "/repo/apps/web/src/App.ts", options: [roleOptions], errors: 2 },
  ],
});

ruleTester.run("require-authz-check", rule("require-authz-check"), {
  valid: [
    "function handler(req) { authorize(req.user); const id = req.params.id; return id; }",
    "function handler(req) { const body = req.body; return body; }",
    // Bug regression: outer authorize should NOT suppress a violation in an inner callback that
    // accesses params without its own authorize call. Before the fix, sawAuthz was set on ALL
    // frames, so the inner callback got credit for the outer function's authorize call.
    "function outer(req) { authorize(req.user); }",
  ],
  invalid: [
    { code: "function handler(req) { const id = req.params.id; return id; }", errors: 1 },
    // Regression case: outer authorize must not suppress inner violation.
    { code: "function outer(req) { authorize(req.user); function inner(req) { const id = req.params.id; return id; } }", errors: 1 },
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
  ],
});
