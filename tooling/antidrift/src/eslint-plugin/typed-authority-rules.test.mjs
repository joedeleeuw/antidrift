import { resolve } from "node:path";

import {
  fixture,
  fixturesDir,
  rule,
  ruleTester,
  typedRuleTester,
} from "../../test/support/eslint-plugin-harness.mjs";

const typeServiceMessage = /requires TypeScript parser services/u;
const typeServiceGuardedRules = [
  "react-max-component-props",
  "no-appeasement-cast",
  "no-canonical-model-fork",
  "no-contract-appeasement-projection",
  "no-defensive-shape-probing",
  "no-redundant-zod-parse",
  "no-parse-as-cast",
  "no-appeasement-erasure",
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

typedRuleTester.run(
  "react-max-component-props",
  rule("react-max-component-props"),
  {
    valid: [
      {
        code: `
          interface PanelProps {
            title: string;
            subtitle: string;
            disabled?: boolean;
          }

          export function Panel(props: PanelProps) {
            return <section>{props.title}</section>;
          }
        `,
        options: [{ max: 3 }],
      },
      {
        code: `
          interface LoaderInput {
            a: string;
            b: string;
            c: string;
            d: string;
            e: string;
          }

          export function load(input: LoaderInput) {
            return input.a;
          }
        `,
        options: [{ max: 3 }],
      },
      {
        code: `
          import type { ComponentProps } from "react";

          type ButtonProps = ComponentProps<"button"> & {
            tone?: "primary" | "secondary";
            size?: "sm" | "lg";
          };

          export function Button(props: ButtonProps) {
            return <button {...props} />;
          }
        `,
        options: [{ max: 2 }],
      },
      {
        code: `
          type BaseProps = {
            one: string;
            two: string;
            three: string;
            four: string;
          };

          const Base = (_props: BaseProps) => null;

          export function Wrapper(props: BaseProps) {
            return <Base {...props} />;
          }
        `,
        options: [{ max: 3 }],
      },
    ],
    invalid: [
      {
        code: `
          interface PanelProps {
            title: string;
            subtitle: string;
            status: string;
            count: number;
          }

          export function Panel(props: PanelProps) {
            return <section>{props.title}</section>;
          }
        `,
        options: [{ max: 3 }],
        errors: [{ message: /too many locally-owned props \(4 > 3\)/u }],
      },
      {
        code: `
          type PanelProps = {
            title: string;
            subtitle: string;
            status: string;
            count: number;
            onSelect(): void;
          };

          export const Panel = ({ title }: PanelProps) => <section>{title}</section>;
        `,
        options: [{ max: 4 }],
        errors: [{ message: /too many locally-owned props \(5 > 4\)/u }],
      },
      {
        code: `
          import type { FC } from "react";

          type PanelProps = {
            title: string;
            subtitle: string;
            status: string;
            count: number;
          };

          export const Panel: FC<PanelProps> = (props) => <section>{props.title}</section>;
        `,
        options: [{ max: 3 }],
        errors: [{ message: /too many locally-owned props \(4 > 3\)/u }],
      },
      {
        code: `
          import { memo } from "react";

          type PanelProps = {
            title: string;
            subtitle: string;
            status: string;
            count: number;
          };

          export const Panel = memo(function Panel(props: PanelProps) {
            return <section>{props.title}</section>;
          });
        `,
        options: [{ max: 3 }],
        errors: [{ message: /too many locally-owned props \(4 > 3\)/u }],
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

ruleTester.run("no-sql-string-concat", rule("no-sql-string-concat"), {
  valid: [
    fixture("programs/correct/static-parameterized-sql-template.ts"),
    "const msg = `generated from ${source}`;",
    fixture("programs/correct/parameterized-sql-query.ts"),
    {
      code: 'import { sql as drizzleSql } from "drizzle-orm/sql/sql";\ndeclare const id: string;\nconst rows = drizzleSql`SELECT * FROM users WHERE id = ${id}`;\nvoid rows;',
      options: [
        {
          safeTemplateTags: [{ module: "drizzle-orm/sql/sql", export: "sql" }],
        },
      ],
    },
    {
      code: 'import { sql } from "drizzle-orm";\nconst rows = sql`SELECT ${sql.raw("CURRENT_TIMESTAMP")}`;\nvoid rows;',
      options: [
        {
          safeTemplateTags: [{ module: "drizzle-orm", export: "sql" }],
        },
      ],
    },
  ],
  invalid: [
    { ...fixture("programs/drift/sql-template-interpolation.ts"), errors: 1 },
    { ...fixture("programs/drift/sql-string-concat.ts"), errors: 1 },
    {
      code: "function loadUser(id) { function sql(strings, ...values) { return String.raw({ raw: strings }, ...values); } return sql`SELECT * FROM users WHERE id = ${id}`; }\nvoid loadUser;",
      errors: 1,
    },
    {
      code: "const db = { sql(strings, ...values) { return String.raw({ raw: strings }, ...values); } };\nfunction loadUser(id) { return db.sql`SELECT * FROM users WHERE id = ${id}`; }\nvoid loadUser;",
      errors: 1,
    },
    {
      code: "declare const id: string;\nconst db = { sql(strings, ...values) { return String.raw({ raw: strings }, ...values); } };\nconst row = db.sql`SELECT * FROM users WHERE id = ${id}`;\nvoid row;",
      options: [
        {
          safeTemplateTags: [
            {
              type: "DatabaseClient",
              member: "sql",
              source: "/database-client.ts",
            },
          ],
        },
      ],
      errors: 1,
    },
    {
      code: 'import { sql } from "drizzle-orm";\ndeclare const columnName: string;\nconst rows = sql`SELECT ${sql.raw(columnName)} FROM users`;\nvoid rows;',
      options: [
        {
          safeTemplateTags: [{ module: "drizzle-orm", export: "sql" }],
        },
      ],
      errors: 1,
    },
    {
      code: 'import { sql } from "drizzle-orm";\ndeclare const columnName: string;\ndeclare const useDynamic: boolean;\nconst rows = sql`SELECT ${useDynamic ? sql.raw(columnName) : sql.raw("id")} FROM users`;\nvoid rows;',
      options: [
        {
          safeTemplateTags: [{ module: "drizzle-orm", export: "sql" }],
        },
      ],
      errors: 1,
    },
    {
      code: 'import { sql } from "drizzle-orm";\ndeclare const columnName: string;\ndeclare const fallback: string;\nconst rows = sql`SELECT ${fallback || sql.raw(columnName)} FROM users`;\nvoid rows;',
      options: [
        {
          safeTemplateTags: [{ module: "drizzle-orm", export: "sql" }],
        },
      ],
      errors: 1,
    },
  ],
});

typedRuleTester.run(
  "no-sql-string-concat safe template tag provenance",
  rule("no-sql-string-concat"),
  {
    valid: [
      {
        code: "declare const id: string;\nabstract class AbstractPostgresConnection { sql(strings: TemplateStringsArray, ...values: unknown[]) { return [strings, values]; } }\nclass DatabaseClient extends AbstractPostgresConnection {}\ndeclare const db: DatabaseClient;\nconst rows = db.sql`SELECT * FROM users WHERE id = ${id}`;\nvoid rows;",
        filename: resolve(fixturesDir, "coupled-state.ts"),
        options: [
          {
            safeTemplateTags: [
              {
                type: "AbstractPostgresConnection",
                member: "sql",
                source: "/coupled-state.ts",
              },
            ],
          },
        ],
      },
      {
        code: "declare const id: string;\nclass Agent { sql(strings: TemplateStringsArray, ...values: unknown[]) { return [strings, values]; } }\nclass AIChatAgent extends Agent { load() { return this.sql`SELECT * FROM users WHERE id = ${id}`; } }\nvoid AIChatAgent;",
        filename: resolve(fixturesDir, "coupled-state.ts"),
        options: [
          {
            safeTemplateTags: [
              { type: "Agent", member: "sql", source: "/coupled-state.ts" },
            ],
          },
        ],
      },
    ],
    invalid: [
      {
        code: "declare const id: string;\nclass UntrustedDatabase { sql(strings: TemplateStringsArray, ...values: unknown[]) { return String.raw({ raw: strings }, ...values); } }\ndeclare const db: UntrustedDatabase;\nconst row = db.sql`SELECT * FROM users WHERE id = ${id}`;\nvoid row;",
        options: [
          {
            safeTemplateTags: [
              {
                type: "DatabaseClient",
                member: "sql",
                source: "/database-client.ts",
              },
            ],
          },
        ],
        errors: 1,
      },
      {
        code: "declare const id: string;\nclass Agent { sql(strings: TemplateStringsArray, ...values: unknown[]) { return String.raw({ raw: strings }, ...values); } }\ndeclare const agent: Agent;\nconst row = agent.sql`SELECT * FROM users WHERE id = ${id}`;\nvoid row;",
        filename: resolve(fixturesDir, "coupled-state.ts"),
        options: [
          {
            safeTemplateTags: [
              {
                type: "Agent",
                member: "sql",
                source: "/not-the-source.ts",
              },
            ],
          },
        ],
        errors: 1,
      },
      {
        code: "declare const columnName: string;\ninterface SqlTag { (strings: TemplateStringsArray, ...values: unknown[]): unknown; raw(value: string): unknown; }\nclass AbstractPostgresConnection { sql: SqlTag = Object.assign((strings: TemplateStringsArray, ...values: unknown[]) => [strings, values], { raw: (value: string) => value }); }\ndeclare const db: AbstractPostgresConnection;\nconst rows = db.sql`SELECT ${db.sql.raw(columnName)} FROM users`;\nvoid rows;",
        filename: resolve(fixturesDir, "coupled-state.ts"),
        options: [
          {
            safeTemplateTags: [
              {
                type: "AbstractPostgresConnection",
                member: "sql",
                source: "/coupled-state.ts",
              },
            ],
          },
        ],
        errors: 1,
      },
    ],
  },
);

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

const acceptedPackageStructuralOptions = {
  packageTypeOwners: {
    firebaseAuthUserInfo: {
      package: "@firebase/auth",
      exportName: "UserInfo",
      reason: "Firebase Auth UserInfo is the accepted auth user info contract.",
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
      {
        ...fixture("programs/edge/partial-subset.ts"),
        options: [acceptedPackageStructuralOptions],
      },
      {
        code: `
          export type ReleaseSummary = {
            id: string;
            appId: string;
            version: string;
            status: "draft" | "submitted" | "released";
          };
        `,
        options: [generatedStructuralOptions],
      },
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
      {
        code: `
          export type ProjectListItem = {
            id: string;
            slug: string;
            name: string;
            ownerId: string;
          };
        `,
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
    // External framework call results are legitimate boundary parses
    fixture("programs/correct/zod-external-call-boundary.ts"),
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
    // Re-parse of an Array.find result already typed as the schema output
    { ...fixture("programs/drift/zod-reparse-array-find.ts"), errors: 1 },
    // Re-parse of assigned and inline synchronous local helper results
    {
      ...fixture("programs/drift/zod-reparse-sync-helper-result.ts"),
      errors: 2,
    },
    // safeParse of a value this schema already validated
    { ...fixture("programs/drift/zod-safe-parse-variants.ts"), errors: 1 },
  ],
});

// ─── no-parse-as-cast fixture suite ───────────────────────────────────────────
// Declared-contract based: fires when a parameter is already typed as the schema
// output, so the parse coerces rather than validates. Complements
// no-redundant-zod-parse, which needs local parse provenance this case never has.
typedRuleTester.run("no-parse-as-cast", rule("no-parse-as-cast"), {
  valid: [
    // unknown/any parameters are real boundaries — the parse earns the contract
    fixture("programs/correct/parse-as-cast-boundary-inputs.ts"),
    // Call results, not parameters — no-redundant-zod-parse owns that provenance
    fixture("programs/drift/zod-reparse-sync-helper-result.ts"),
    // External SDK result boundary must stay clean
    fixture("programs/correct/zod-external-call-boundary.ts"),
  ],
  invalid: [
    // Parameter declared as the schema output and parsed with that schema
    { ...fixture("programs/drift/zod-reparse-typed-value.ts"), errors: 1 },
    // Real shape from the murderbox desktop IPC bridge: schema reached through a
    // contract object, parameter typed as z.infer of that same schema
    {
      ...fixture("programs/drift/parse-as-cast-contract-schema.ts"),
      errors: 1,
    },
    // safeParse is the same coercion with a different error model
    { ...fixture("programs/drift/zod-safe-parse-variants.ts"), errors: 1 },
  ],
});

// ─── no-appeasement-erasure fixture suite ─────────────────────────────────────
// Fires when a known type is widened to unknown and a contract is then
// re-established from it by a parse or a named cast. Widening an any-returning
// source, or widening with no downstream contract, stays clean.
typedRuleTester.run(
  "no-appeasement-erasure",
  rule("no-appeasement-erasure"),
  {
    valid: [
      fixture("programs/correct/appeasement-erasure-real-boundaries.ts"),
      // unknown/any parameters are real boundaries, not erasures
      fixture("programs/correct/parse-as-cast-boundary-inputs.ts"),
      // External SDK result parsed directly — no erased binding involved
      fixture("programs/correct/zod-external-call-boundary.ts"),
    ],
    invalid: [
      // Erased-then-parsed and erased-then-cast, the two IPC edge shapes
      {
        ...fixture("programs/drift/appeasement-erasure-ipc-result.ts"),
        errors: 3,
      },
    ],
  },
);
