import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import tsParser from "@typescript-eslint/parser";
import { RuleTester } from "@typescript-eslint/rule-tester";
import { ESLint } from "eslint";
import { afterAll, describe, expect, it } from "vitest";
import YAML from "yaml";

import plugin from "./index.js";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "fixtures");
const repoRoot = resolve(__dirname, "../../../..");
const semanticFactKinds = YAML.parse(
  readFileSync(resolve(repoRoot, "policy/registries/rules.yaml"), "utf8"),
).semanticFactKinds;

function fixture(relativePath) {
  const fullPath = resolve(fixturesDir, relativePath);
  return { code: readFileSync(fullPath, "utf8"), filename: fullPath };
}

function expectFactMatchesRegistry(fact) {
  const entry = semanticFactKinds[fact.factKind];
  expect(entry).toBeDefined();
  expect(entry.rules).toContain(fact.ruleId);
  expect(fact.adapterId).toBe(entry.adapterId);
  expect(entry.confidence).toContain(fact.confidence);
  for (const field of entry.payloadFields) {
    expect(fact.payload).toHaveProperty(field);
  }
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
      ecmaFeatures: { jsx: true },
      projectService: {
        allowDefaultProject: ["*.ts", "*.tsx"],
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
    {
      ...fixture("programs/drift/async-map-without-promise-all.ts"),
      errors: 1,
    },
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
    {
      code: 'import { useLayoutEffect } from "react"; useLayoutEffect(() => {});',
      errors: 1,
    },
    {
      code: 'import { useEffect as ue } from "react"; ue(() => {});',
      errors: 1,
    },
    {
      code: 'import React from "react"; React.useEffect(() => {});',
      errors: 1,
    },
    {
      code: 'import * as React from "react"; React.useEffect(() => {});',
      errors: 1,
    },
    { ...fixture("programs/drift/effect-missing-deps.ts"), errors: 1 },
  ],
});

ruleTester.run(
  "no-trivial-selector-wrapper",
  rule("no-trivial-selector-wrapper"),
  {
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
      {
        ...fixture("programs/drift/typed-selector-arrow-wrapper.ts"),
        errors: 1,
      },
      {
        ...fixture("programs/drift/typed-nested-selector-wrapper.ts"),
        errors: 1,
      },
      // Same wrapper as a method on an internal class must be caught too
      {
        ...fixture("programs/drift/methods-internal-appeasement.ts"),
        errors: 3,
      },
      { ...fixture("programs/drift/object-literal-appeasement.ts"), errors: 1 },
      {
        ...fixture("programs/drift/destructured-param-selector-wrapper.ts"),
        errors: 2,
      },
    ],
  },
);

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

typedRuleTester.run(
  "no-defensive-shape-probing",
  rule("no-defensive-shape-probing"),
  {
    valid: [
      fixture("programs/correct/owned-type-guard-or-schema.ts"),
      fixture("programs/correct/narrow-then-assign.ts"),
    ],
    invalid: [
      {
        ...fixture("programs/drift/object-entries-shape-probing.ts"),
        errors: 1,
      },
    ],
  },
);

typedRuleTester.run(
  "no-underchecked-type-predicate",
  rule("no-underchecked-type-predicate"),
  {
    valid: [
      "type TriggerTitle = { title: string; subtitle?: string; args?: string[] };\nconst isTriggerTitle = (value: any): value is TriggerTitle => typeof value === 'object' && value !== null && 'title' in value;",
      "type OptionalDisplay = { titleClass?: string; subtitleClass?: string };\nconst isOptionalDisplay = (value: unknown): value is OptionalDisplay => typeof value === 'object' && value !== null;",
      "type DateMessage = { year: number; month: number; day: number };\nfunction isDateMessage(value: unknown): value is DateMessage { return typeof value === 'object' && value !== null && 'year' in value && 'month' in value && 'day' in value; }",
    ],
    invalid: [
      {
        code: "type User = { id: string; email: string; active?: boolean };\nfunction isUser(value: unknown): value is User { return typeof value === 'object' && value !== null && 'id' in value; }",
        errors: 1,
      },
      {
        code: "type User = { id: string; email: string };\nfunction isUser(value: unknown): value is User { return typeof value === 'object' && value !== null; }",
        errors: 1,
      },
    ],
  },
);

ruleTester.run(
  "no-handrolled-resource-lifecycle-cells",
  rule("no-handrolled-resource-lifecycle-cells"),
  {
    valid: [
      fixture("programs/correct/single-state-setter-handler.ts"),
      fixture("programs/correct/sibling-payload-setters.ts"),
      fixture("programs/correct/sibling-component-setter-scope.ts"),
      // Synchronous multi-setter UI cleanup is not a lifecycle machine.
      fixture("programs/correct/multi-setter-ui-cleanup.ts"),
      // Loading + data with no error/catch cell: stale-while-revalidate.
      fixture("programs/correct/stale-while-revalidate.ts"),
      // Append via updater fn is incremental pagination, not a fresh resource load.
      fixture("programs/correct/pagination-next-page.ts"),
      // Full lifecycle shape, but request-identity guarded by AbortController.
      fixture("programs/correct/abort-guarded-fetch.ts"),
      // Owned resource hook: no local useState cells to couple.
      fixture("programs/correct/owned-resource-hook.ts"),
      // Request guard constructed at component scope (useRef) still exempts the transition.
      fixture("programs/correct/abort-guarded-component-scope.ts"),
    ],
    invalid: [
      {
        ...fixture("programs/drift/handrolled-resource-lifecycle.ts"),
        errors: 1,
      },
    ],
  },
);

const generatedStructuralOptions = {
  generatedSources: {
    fixtureGenerated: {
      generated: "programs/generated",
    },
  },
};

typedRuleTester.run(
  "no-shattered-ingested-entity-state",
  rule("no-shattered-ingested-entity-state"),
  {
    valid: [
      {
        code: `
          import { useState } from "react";
          declare namespace JSX { interface IntrinsicElements { input: any; form: any; } }
          declare function fetchProfile(): Promise<{ id: string; displayName: string }>;
          function ProfileForm() {
            const [id, setId] = useState("");
            const [name, setName] = useState("");
            async function load() {
              const profile = await fetchProfile();
              setId(profile.id);
              setName(profile.displayName);
            }
            return <form>
              <input value={id} onChange={(event) => setId(event.currentTarget.value)} />
              <input value={name} onChange={(event) => setName(event.currentTarget.value)} />
            </form>;
          }
          void ProfileForm;
        `,
        filename: "profile-form.tsx",
      },
      `
        import { useState } from "react";
        declare function fetchUser(): Promise<{ id: string; name: string }>;
        function UserPanel() {
          const [user, setUser] = useState<{ id: string; name: string } | null>(null);
          return async function load() {
            const next = await fetchUser();
            setUser(next);
          };
        }
        void UserPanel;
      `,
      `
        import { useState } from "react";
        declare function fetchUser(): Promise<{ id: string; name: string }>;
        function UserPanel() {
          const [id, setId] = useState("");
          const [label, setLabel] = useState("");
          return async function load() {
            const next = await fetchUser();
            setId(next.id);
            setLabel("loaded");
          };
        }
        void UserPanel;
      `,
      {
        code: `
          import { useState } from "react";
          import type { User } from "./programs/correct/packages/domain/src/user";
          declare function fetchUsersPage(): Promise<{
            items: User[];
            nextCursor: string | null;
          }>;
          function UsersPage() {
            const [items, setItems] = useState<User[]>([]);
            const [nextCursor, setNextCursor] = useState<string | null>(null);
            return async function load() {
              const page = await fetchUsersPage();
              setItems(page.items);
              setNextCursor(page.nextCursor);
            };
          }
          void UsersPage;
        `,
        filename: "users-page.tsx",
      },
      {
        code: `
          import { useState } from "react";
          import type { User } from "./programs/correct/packages/domain/src/user";
          declare function fetchUserEnvelope(): Promise<{
            entity: User;
            fetchedAt: string;
          }>;
          function UserEnvelopePanel() {
            const [entity, setEntity] = useState<User | null>(null);
            const [fetchedAt, setFetchedAt] = useState("");
            return async function load() {
              const envelope = await fetchUserEnvelope();
              setEntity(envelope.entity);
              setFetchedAt(envelope.fetchedAt);
            };
          }
          void UserEnvelopePanel;
        `,
        filename: "user-envelope-panel.tsx",
      },
    ],
    invalid: [],
  },
);

ruleTester.run(
  "no-inline-structural-type-at-use-site",
  rule("no-inline-structural-type-at-use-site"),
  {
    valid: [
      fixture("programs/correct/named-structural-parameter-type.ts"),
      "import type { ReactNode } from 'react';\nexport function Shell({ children }: { children: ReactNode }) { return children; }",
      "type Props = { onConfirm: (date: { year: number; month: number; day: number }) => void }; void ({} as Props);",
      "const formatDate = (date: { year: number; month: number; day: number }) => String(date.year); void formatDate;",
    ],
    invalid: [
      {
        ...fixture("programs/drift/inline-structural-parameter-type.ts"),
        errors: 1,
      },
      {
        code: "export const createApi = () => ({ saveUser: async (req: { id: string; email: string }) => req.email });",
        errors: 1,
      },
    ],
  },
);

ruleTester.run("no-raw-tailwind-color", rule("no-raw-tailwind-color"), {
  valid: [fixture("programs/correct/semantic-tailwind-token.tsx")],
  invalid: [
    { ...fixture("programs/drift/raw-tailwind-color-class.tsx"), errors: 1 },
  ],
});

ruleTester.run("no-hover-translate-card", rule("no-hover-translate-card"), {
  valid: [fixture("programs/correct/hover-shadow-card.tsx")],
  invalid: [
    { ...fixture("programs/drift/hover-translate-card.tsx"), errors: 1 },
  ],
});

ruleTester.run("no-raw-fetch-in-component", rule("no-raw-fetch-in-component"), {
  valid: [fixture("programs/correct/raw-fetch-in-helper.ts")],
  invalid: [
    { ...fixture("programs/drift/raw-fetch-in-component.tsx"), errors: 1 },
    {
      ...fixture("programs/drift/raw-fetch-in-component-module-helper.tsx"),
      errors: 1,
    },
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

const statusOptions = {
  statuses: {
    UserStatus: {
      owner: "packages/domain/src/user.ts",
      values: ["active", "disabled", "invited"],
    },
  },
};

ruleTester.run("no-status-literal-in-type", rule("no-status-literal-in-type"), {
  valid: [
    {
      ...fixture("programs/correct/packages/domain/src/user.ts"),
      options: [statusOptions],
    },
    {
      code: "const x = user.status === 'active';",
      filename: "/repo/apps/web/src/App.ts",
      options: [statusOptions],
    },
    {
      code: "type BadgeProps = { variant: 'active' | 'disabled' };",
      filename: "/repo/apps/web/src/Badge.ts",
      options: [statusOptions],
    },
  ],
  invalid: [
    {
      ...fixture("programs/drift/status-literal-type-fork.ts"),
      options: [statusOptions],
      errors: 2,
    },
  ],
});

ruleTester.run(
  "no-nullable-positional-tuple",
  rule("no-nullable-positional-tuple"),
  {
    valid: [
      "type CoordinatePair = [number, number];",
      "type OpenRange = [Date | null, Date];",
    ],
    invalid: [
      {
        code: "type CustomRange = [Date | null, Date | null];",
        errors: 1,
      },
      {
        code: "type MaybeBounds = [start?: Date, end?: Date];",
        errors: 1,
      },
    ],
  },
);

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
    {
      ...fixture("programs/drift/nested-params-without-local-authz.ts"),
      errors: 1,
    },
  ],
});

const acceptedPackageStructuralOptions = {
  packageTypeOwners: {
    firebaseAuthUser: {
      package: "@firebase/auth",
      exportName: "User",
      reason: "Firebase Auth User is the accepted auth user contract.",
    },
  },
};

const domainCanonicalOptions = {
  canonicalEntities: {
    Project: "programs/correct/packages/domain/src/project.ts",
  },
};

typedRuleTester.run(
  "no-structural-type-fork",
  rule("no-structural-type-fork"),
  {
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
      fixture("programs/drift/redeclares-full.ts"),
      fixture("programs/drift/redeclares-named-differently.ts"),
      fixture("programs/drift/zod-schema-mirror.ts"),
      fixture("programs/drift/extends-and-redeclares.ts"),
      fixture("programs/drift/multi-file/drift-elsewhere.ts"),
      fixture("programs/edge/partial-subset.ts"),
      fixture("programs/drift/redeclares-optional.ts"),
    ],
    invalid: [
      {
        ...fixture("programs/drift/generated-release-fork.ts"),
        options: [generatedStructuralOptions],
        errors: 1,
      },
      {
        ...fixture("programs/drift/redeclares-full.ts"),
        options: [acceptedPackageStructuralOptions],
        errors: 1,
      },
    ],
  },
);

typedRuleTester.run(
  "no-canonical-model-fork",
  rule("no-canonical-model-fork"),
  {
    valid: [
      {
        ...fixture("programs/correct/packages/domain/src/project.ts"),
        options: [domainCanonicalOptions],
      },
      {
        ...fixture("programs/correct/domain-project-form-draft.ts"),
        options: [domainCanonicalOptions],
      },
    ],
    invalid: [
      {
        ...fixture("programs/drift/domain-project-fork.ts"),
        options: [domainCanonicalOptions],
        errors: 1,
      },
    ],
  },
);

async function lintWithStructuralFacts(file, ruleOptions = {}) {
  const facts = [];
  const drift = fixture(file);
  const eslint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ["**/*.ts"],
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
        plugins: {
          antidrift: plugin,
        },
        rules: {
          "antidrift/no-structural-type-fork": ["error", ruleOptions],
        },
        settings: {
          antidrift: {
            semanticFacts: {
              repoRoot: fixturesDir,
              sink: {
                emit(fact) {
                  facts.push(fact);
                },
              },
            },
          },
        },
      },
    ],
  });

  const [result] = await eslint.lintText(drift.code, {
    filePath: drift.filename,
  });
  return { facts, result };
}

it("emits structural proposal facts for unaccepted installed-package matches", async () => {
  const { facts, result } = await lintWithStructuralFacts(
    "programs/drift/redeclares-full.ts",
  );

  expect(result.messages).toHaveLength(0);
  expect(facts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        factKind: "structuralMatch",
        ruleId: "antidrift/no-structural-type-fork",
        adapterId: "typescript-eslint/type-owner",
        confidence: "deterministic-inventory",
        provenance: expect.arrayContaining(["AST", "TypeChecker"]),
        payload: expect.objectContaining({
          authorityState: "proposal",
          localType: expect.objectContaining({ name: "UserInfo" }),
          ownerType: expect.objectContaining({
            label: expect.stringContaining("#"),
          }),
          structuralMatch: expect.objectContaining({
            relation: "local-subset-of-owner",
          }),
          diagnostic: expect.objectContaining({
            emitted: false,
          }),
        }),
      }),
    ]),
  );
});

it("emits blocking structural facts from accepted generated owners with stable ids", async () => {
  const first = await lintWithStructuralFacts(
    "programs/drift/generated-release-fork.ts",
    generatedStructuralOptions,
  );
  const second = await lintWithStructuralFacts(
    "programs/drift/generated-release-fork.ts",
    generatedStructuralOptions,
  );

  expect(first.result.messages).toHaveLength(1);
  expect(second.result.messages).toHaveLength(1);
  expect(first.facts.map((fact) => fact.factId)).toEqual(
    second.facts.map((fact) => fact.factId),
  );
  expect(first.facts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        confidence: "deterministic-enforcement",
        payload: expect.objectContaining({
          authorityState: "accepted",
          localType: expect.objectContaining({ name: "ReleaseRow" }),
          ownerType: expect.objectContaining({
            label: "fixtureGenerated#GeneratedRelease",
            authority: "generated-source",
          }),
          diagnostic: expect.objectContaining({
            emitted: true,
            messageId: "structuralTypeFork",
          }),
        }),
      }),
    ]),
  );
});

it("emits blocking structural facts from accepted package owners", async () => {
  const { facts, result } = await lintWithStructuralFacts(
    "programs/drift/redeclares-full.ts",
    acceptedPackageStructuralOptions,
  );

  expect(result.messages).toHaveLength(1);
  expect(facts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        confidence: "deterministic-enforcement",
        payload: expect.objectContaining({
          authorityState: "accepted",
          localType: expect.objectContaining({ name: "UserInfo" }),
          ownerType: expect.objectContaining({
            label: "@firebase/auth#User",
            authority: "installed-package",
          }),
          diagnostic: expect.objectContaining({
            emitted: true,
            messageId: "structuralTypeFork",
          }),
        }),
      }),
    ]),
  );
});

async function lintCoupledStateProgramWithFacts(program, options = {}) {
  const facts = [];
  const eslint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ["**/*.ts"],
        languageOptions: {
          parser: tsParser,
          parserOptions: {
            ecmaFeatures: { jsx: true },
            projectService: {
              allowDefaultProject: ["*.ts", "*.tsx"],
              defaultProject: resolve(fixturesDir, "tsconfig.json"),
            },
            tsconfigRootDir: fixturesDir,
          },
        },
        plugins: {
          antidrift: plugin,
        },
        rules: {
          "antidrift/no-handrolled-resource-lifecycle-cells": [
            "error",
            options,
          ],
        },
        settings: {
          antidrift: {
            semanticFacts: {
              repoRoot: fixturesDir,
              sink: {
                emit(fact) {
                  facts.push(fact);
                },
              },
            },
          },
        },
      },
    ],
  });

  const [result] = await eslint.lintText(program.code, {
    filePath: program.filename,
  });
  return { facts, result };
}

async function lintWithCoupledStateFacts(file, options = {}) {
  return lintCoupledStateProgramWithFacts(fixture(file), options);
}

async function lintCoupledStateCodeWithFacts(code, options = {}) {
  return lintCoupledStateProgramWithFacts(
    {
      code,
      filename: resolve(fixturesDir, "coupled-state.ts"),
    },
    options,
  );
}

async function lintSourceShardWithFacts(code, options = {}) {
  const facts = [];
  const eslint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ["**/*.{ts,tsx}"],
        languageOptions: {
          parser: tsParser,
          parserOptions: {
            ecmaFeatures: { jsx: true },
            projectService: {
              allowDefaultProject: ["*.ts", "*.tsx"],
              defaultProject: resolve(fixturesDir, "tsconfig.json"),
            },
            tsconfigRootDir: fixturesDir,
          },
        },
        plugins: {
          antidrift: plugin,
        },
        rules: {
          "antidrift/no-shattered-ingested-entity-state": ["error", options],
        },
        settings: {
          antidrift: {
            semanticFacts: {
              repoRoot: fixturesDir,
              sink: {
                emit(fact) {
                  facts.push(fact);
                },
              },
            },
          },
        },
      },
    ],
  });

  const [result] = await eslint.lintText(code, {
    filePath: resolve(fixturesDir, "source-shard.tsx"),
  });
  return { facts, result };
}

it("emits a deterministic-enforcement lifecycle fact and diagnostic from one proof, with stable ids", async () => {
  const first = await lintWithCoupledStateFacts(
    "programs/drift/handrolled-resource-lifecycle.ts",
  );
  const second = await lintWithCoupledStateFacts(
    "programs/drift/handrolled-resource-lifecycle.ts",
  );

  expect(first.result.messages).toHaveLength(1);
  expect(first.facts.map((fact) => fact.factId)).toEqual(
    second.facts.map((fact) => fact.factId),
  );
  expect(first.facts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        factKind: "resourceLifecycleProof",
        ruleId: "antidrift/no-handrolled-resource-lifecycle-cells",
        adapterId: "react-state",
        confidence: "deterministic-enforcement",
        provenance: expect.arrayContaining([
          "AST",
          "control-flow",
          "scope-binding",
        ]),
        payload: expect.objectContaining({
          boolCell: "setPending",
          errorCell: "setFailure",
          payloadCell: "setUsers",
        }),
      }),
    ]),
  );
});

it("keeps sibling payload setters inventory-only under an aggressive threshold", async () => {
  const { facts, result } = await lintWithCoupledStateFacts(
    "programs/correct/sibling-payload-setters.ts",
    { threshold: 2 },
  );

  expect(result.messages).toHaveLength(0);
  expect(facts.map((fact) => fact.factKind)).not.toContain(
    "resourceLifecycleProof",
  );
  expect(facts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        factKind: "broadSetterCoMutation",
        confidence: "heuristic-inventory",
        payload: expect.objectContaining({ setterCount: 2 }),
      }),
    ]),
  );
});

it("proves lifecycle from derived catch writes and awaited source-member payloads", async () => {
  const { facts, result } = await lintCoupledStateCodeWithFacts(`
    import { useState } from "react";
    declare function fetchRows(): Promise<{ rows: string[] }>;
    declare function codeFrom(error: unknown): string;

    function RowsPanel() {
      const [rows, setRows] = useState<string[]>([]);
      const [pending, setPending] = useState(false);
      const [errorCode, setErrorCode] = useState("");

      return async function load() {
        setPending(true);
        try {
          const response = await fetchRows();
          setRows(response.rows);
        } catch (err) {
          setErrorCode(codeFrom(err));
        } finally {
          setPending(false);
        }
      };
    }

    void RowsPanel;
  `);

  expect(result.messages).toHaveLength(1);
  expect(facts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        factKind: "resourceLifecycleProof",
        confidence: "deterministic-enforcement",
        payload: expect.objectContaining({
          boolCell: "setPending",
          errorCell: "setErrorCode",
          payloadCell: "setRows",
        }),
      }),
    ]),
  );
});

it("ignores local useState impostors for React-state facts", async () => {
  const lifecycle = await lintCoupledStateCodeWithFacts(`
    function useState<T>(value: T): [T, (value: T) => void] {
      return [value, () => undefined];
    }
    declare function loadUsers(): Promise<string[]>;

    function UsersPanel() {
      const [users, setUsers] = useState<string[]>([]);
      const [pending, setPending] = useState(false);
      const [failure, setFailure] = useState<Error | null>(null);

      return async function load() {
        setPending(true);
        setFailure(null);
        try {
          const result = await loadUsers();
          setUsers(result);
        } catch (err) {
          setFailure(err);
        } finally {
          setPending(false);
        }
      };
    }

    void UsersPanel;
  `);
  const sourceShard = await lintSourceShardWithFacts(`
    function useState<T>(value: T): [T, (value: T) => void] {
      return [value, () => undefined];
    }
    declare function fetchProfile(): Promise<{ id: string; displayName: string }>;
    function ProfileCard() {
      const [id, setId] = useState("");
      const [name, setName] = useState("");
      return async function load() {
        const profile = await fetchProfile();
        setId(profile.id);
        setName(profile.displayName);
      };
    }
    void ProfileCard;
  `);

  expect(lifecycle.result.messages).toHaveLength(0);
  expect(sourceShard.result.messages).toHaveLength(0);
  expect(lifecycle.facts).toHaveLength(0);
  expect(sourceShard.facts).toHaveLength(0);
});

it("downgrades a request-guarded lifecycle to heuristic-inventory with no diagnostic", async () => {
  const { facts, result } = await lintWithCoupledStateFacts(
    "programs/correct/abort-guarded-fetch.ts",
  );

  expect(result.messages).toHaveLength(0);
  expect(facts.map((fact) => fact.factKind)).not.toContain(
    "resourceLifecycleProof",
  );
  expect(facts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        factKind: "broadSetterCoMutation",
        confidence: "heuristic-inventory",
        payload: expect.objectContaining({ requestGuard: true }),
      }),
    ]),
  );
});

it("does not downgrade lifecycle proof for unrelated abort-shaped members", async () => {
  const { facts, result } = await lintCoupledStateCodeWithFacts(`
    import { useState } from "react";
    declare const request: { aborted: boolean };
    declare const fake: { abort(): void; signal: { aborted: boolean } };
    declare function loadUsers(): Promise<string[]>;

    function UsersPanel() {
      const [users, setUsers] = useState<string[]>([]);
      const [pending, setPending] = useState(false);
      const [failure, setFailure] = useState<Error | null>(null);

      return async function load() {
        setPending(true);
        setFailure(null);
        try {
          const result = await loadUsers();
          if (request.aborted) return;
          fake.abort();
          if (fake.signal.aborted) return;
          setUsers(result);
        } catch (err) {
          setFailure(err);
        } finally {
          setPending(false);
        }
      };
    }

    void UsersPanel;
  `);

  expect(result.messages).toHaveLength(1);
  expect(facts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        factKind: "resourceLifecycleProof",
        confidence: "deterministic-enforcement",
        payload: expect.objectContaining({
          boolCell: "setPending",
          errorCell: "setFailure",
          payloadCell: "setUsers",
          requestGuard: false,
        }),
      }),
    ]),
  );
});

it("downgrades a useRef AbortController lifecycle to heuristic-inventory with no diagnostic", async () => {
  const { facts, result } = await lintWithCoupledStateFacts(
    "programs/correct/abort-guarded-component-scope.ts",
  );

  expect(result.messages).toHaveLength(0);
  expect(facts.map((fact) => fact.factKind)).not.toContain(
    "resourceLifecycleProof",
  );
  expect(facts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        factKind: "broadSetterCoMutation",
        confidence: "heuristic-inventory",
        payload: expect.objectContaining({ requestGuard: true }),
      }),
    ]),
  );
});

it("emits a source-member shard candidate fact (inventory-only, no diagnostic)", async () => {
  const { facts, result } = await lintSourceShardWithFacts(`
    import { useState } from "react";
    declare function fetchProfile(): Promise<{ id: string; displayName: string }>;
    function ProfileCard() {
      const [id, setId] = useState("");
      const [name, setName] = useState("");
      return async function load() {
        const profile = await fetchProfile();
        setId(profile.id);
        setName(profile.displayName);
      };
    }
    void ProfileCard;
  `);

  expect(result.messages).toHaveLength(0);
  expect(facts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        factKind: "sourceMemberStateShardCandidate",
        ruleId: "antidrift/no-shattered-ingested-entity-state",
        adapterId: "react-state",
        confidence: "heuristic-inventory",
        payload: expect.objectContaining({
          source: "profile",
          editableCells: [],
          members: expect.arrayContaining([
            { setter: "setId", cell: "id", property: "id" },
            { setter: "setName", cell: "name", property: "displayName" },
          ]),
        }),
      }),
    ]),
  );
});

it("emits semantic facts that satisfy the registered public payload contract", async () => {
  const structural = await lintWithStructuralFacts(
    "programs/drift/redeclares-full.ts",
  );
  const lifecycle = await lintWithCoupledStateFacts(
    "programs/drift/handrolled-resource-lifecycle.ts",
  );
  const inventory = await lintWithCoupledStateFacts(
    "programs/correct/sibling-payload-setters.ts",
    { threshold: 2 },
  );
  const sourceShardCandidate = await lintSourceShardWithFacts(`
    import { useState } from "react";
    declare function fetchProfile(): Promise<{ id: string; displayName: string }>;
    function ProfileCard() {
      const [id, setId] = useState("");
      const [name, setName] = useState("");
      return async function load() {
        const profile = await fetchProfile();
        setId(profile.id);
        setName(profile.displayName);
      };
    }
    void ProfileCard;
  `);
  const facts = [
    ...structural.facts,
    ...lifecycle.facts,
    ...inventory.facts,
    ...sourceShardCandidate.facts,
  ];

  const pluginEmittedKinds = Object.entries(semanticFactKinds)
    .filter(([, contract]) => (contract.rules?.length ?? 0) > 0)
    .map(([kind]) => kind);
  expect(facts.map((fact) => fact.factKind)).toEqual(
    expect.arrayContaining(pluginEmittedKinds),
  );
  for (const fact of facts) {
    expectFactMatchesRegistry(fact);
  }
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
    {
      ...fixture("programs/drift/zod-reparse-cross-fn-same-file.ts"),
      errors: 1,
    },
    // Re-parse of a service/helper result already typed as the schema output
    { ...fixture("programs/drift/zod-reparse-service-result.ts"), errors: 1 },
  ],
});
