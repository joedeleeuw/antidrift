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
  "no-canonical-model-fork",
  "no-contract-appeasement-projection",
  "no-defensive-shape-probing",
  "no-identity-schema-transform",
  "no-explicit-type-arguments-on-owned-api",
  "no-schema-validator-transcoding",
  "no-redundant-local-return-type",
  "no-redundant-zod-parse",
  "no-appeasement-erasure",
  "no-structural-type-fork",
  "no-underchecked-type-predicate",
  "require-convex-return-validator",
];

typedRuleTester.run(
  "no-redundant-local-return-type",
  rule("no-redundant-local-return-type"),
  {
    valid: [
      `
        type SelectedConfigData = { configs: string[]; selectedId: string; selected: string };
        export function toSelection(configs: string[]): SelectedConfigData {
          const selectedId = "default";
          const selected = configs[0] ?? "default";
          return { configs, selectedId, selected };
        }
      `,
      `
        type SelectedConfigData = { configs: string[]; selectedId: string; selected: string };
        function build(configs: string[]) {
          const toSelection = (id: string): SelectedConfigData => {
            const selectedId = id;
            const selected = configs[0] ?? id;
            return { configs, selectedId, selected };
          };
          return toSelection("default");
        }
      `,
      `
        type SelectedConfigData = { configs: string[]; selectedId: string; selected: string };
        function build(configs: string[]) {
          const toSelection = (id: string): SelectedConfigData => {
            const selectedId = id;
            const selected = configs[0] ?? id;
            if (selected === "again") return { configs, selectedId, selected };
            return { configs, selectedId, selected };
          };
          return toSelection("default");
        }
      `,
      `
        type SelectedConfigData = { configs: string[]; selectedId: string; selected: string };
        function build(configs: string[], ids: string[]) {
          const toSelection = (id: string): SelectedConfigData => {
            const selectedId = id;
            const selected = configs[0] ?? id;
            return { configs, selectedId, selected };
          };
          return ids.map(toSelection);
        }
      `,
      `
        type SelectedConfigData = { readonly configs: string[]; selectedId: string; selected: string };
        function build(configs: string[]) {
          const toSelection = (id: string): SelectedConfigData => {
            const selectedId = id;
            const selected = configs[0] ?? id;
            return { configs, selectedId, selected };
          };
          return toSelection("default");
        }
      `,
      `
        type SelectedConfigData = { configs: string[]; selectedId: string; selected?: string };
        function build(configs: string[]) {
          const toSelection = (id: string): SelectedConfigData => {
            const selectedId = id;
            const selected = configs[0] ?? id;
            return { configs, selectedId, selected };
          };
          return toSelection("default");
        }
      `,
      `
        type SelectedConfigData = { configs: string[]; selectedId: string; selected: string };
        function build(configs: string[]) {
          const toSelection: (id: string) => SelectedConfigData = (id): SelectedConfigData => {
            const selectedId = id;
            const selected = configs[0] ?? id;
            return { configs, selectedId, selected };
          };
          return toSelection("default");
        }
      `,
      `
        type Result = { value: number; next: () => Result };
        function build() {
          const recurse = (): Result => {
            const value = 1;
            const next = recurse;
            return { value, next };
          };
          return recurse();
        }
      `,
      `
        type SelectedConfigData = { configs: string[]; selectedId: string; selected: string };
        export function createSelector(configs: string[]) {
          const toSelection = (id: string): SelectedConfigData => {
            const selectedId = id;
            const selected = configs[0] ?? id;
            return { configs, selectedId, selected };
          };
          return { toSelection };
        }
      `,
      `
        type SelectedConfigData = { configs: string[]; selectedId: string; selected: string };
        export function createSelector(configs: string[]) {
          const toSelection = (id: string): SelectedConfigData => {
            const selectedId = id;
            const selected = configs[0] ?? id;
            return { configs, selectedId, selected };
          };
          return toSelection;
        }
      `,
      `
        type Result = { value: number };
        function build() {
          function toSelection(value: number): Result;
          function toSelection(value: number | string): Result;
          function toSelection(input: number | string): Result {
            const value = Number(input);
            return { value };
          }
          return toSelection(1);
        }
      `,
      `
        type Left = { right: Right };
        type Right = { left: Left };
        function build() {
          const left = (): Left => {
            const right = rightValue();
            return { right };
          };
          const rightValue = (): Right => {
            const left = left();
            return { left };
          };
          return left();
        }
      `,
      `
        type SelectedConfigData = { configs: string[]; selectedId: string; selected: string };
        function build(configs: string[]) {
          return configs.map((selected, index): SelectedConfigData => ({
            configs,
            selectedId: String(index),
            selected,
          }));
        }
      `,
      `
        type Status = { status: string };
        function build() {
          const toSelection = (): Status => {
            const status = "ready" as const;
            return { status };
          };
          return toSelection();
        }
      `,
      `
        type Result = { value: number };
        function build(): Result {
          const create = (): Result => {
            const value = 1;
            return { value };
          };
          return create();
        }
        export const api = { build };
      `,
      `
        type Result = { value: number };
        declare function wrap<T>(value: T): T;
        function build(): Result {
          const create = (): Result => {
            const value = 1;
            return { value };
          };
          return create();
        }
        export default wrap(build);
      `,
      `
        type Result = { value: number };
        function build(): Result {
          const create = (): Result => {
            const value = 1;
            return { value };
          };
          return create();
        }
        export { build as apiFactory };
      `,
    ],
    invalid: [
      {
        code: `
          type SelectedConfigData = { configs: string[]; selectedId: string; selected: string };
          function build(configs: string[]): SelectedConfigData {
            const toSelection = (id: string): SelectedConfigData => {
              const selectedId = id;
              const selected = configs[0] ?? id;
              return { configs, selectedId, selected };
            };
            return toSelection("default");
          }
        `,
        errors: [{ messageId: "redundantLocalReturnType" }],
      },
      {
        code: `
          type SelectedConfigData = { configs: string[]; selectedId: string; selected: string };
          function build(configs: string[]): SelectedConfigData {
            function toSelection(id: string): SelectedConfigData {
              const selectedId = id;
              const selected = configs[0] ?? id;
              return { configs, selectedId, selected };
            }
            return toSelection("default");
          }
        `,
        errors: [{ messageId: "redundantLocalReturnType" }],
      },
      {
        code: `
          type VideoModelId = "first" | "second";
          type SelectedConfigData = { configs: VideoModelId[]; selectedId: VideoModelId; selected: VideoModelId };
          function selectedVideoConfigDataFor(): Record<VideoModelId, SelectedConfigData> {
            const toSelection = (id: VideoModelId): SelectedConfigData => {
              const configs = [id];
              const selectedId = id;
              const selected = configs[0] ?? id;
              return { configs, selectedId, selected };
            };
            return {
              first: toSelection("first"),
              second: toSelection("second"),
            };
          }
        `,
        errors: [{ messageId: "redundantLocalReturnType" }],
      },
    ],
  }
);

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
  }
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
      // A tag that returns rows, not a string, binds its values: by its declared signature alone
      "type SqlTaggedTemplate = { <T = Record<string, unknown>>(strings: TemplateStringsArray, ...values: (string | number | boolean | null)[]): T[] };\ndeclare const sql: SqlTaggedTemplate;\ndeclare const id: string;\nconst rows = sql`SELECT * FROM users WHERE id = ${id}`;\nvoid rows;",
      // ...and when its body builds `?` placeholders and passes the values to the driver
      "declare const storage: { exec(query: string, ...values: unknown[]): Iterable<Record<string, unknown>> };\nclass Agent {\n  sql<T>(strings: TemplateStringsArray, ...values: (string | number | boolean | null)[]): T[] {\n    const query = strings.reduce((acc, str, i) => acc + str + (i < values.length ? '?' : ''), '');\n    return [...storage.exec(query, ...values)] as T[];\n  }\n  load(id: string) { return this.sql`SELECT * FROM users WHERE id = ${id}`; }\n}\nvoid Agent;",
      "interface SqlTag { (strings: TemplateStringsArray, ...values: unknown[]): { text: string; values: unknown[] }; raw(value: string): { text: string; values: unknown[] }; }\ndeclare const sql: SqlTag;\nconst rows = sql`SELECT ${sql.raw('CURRENT_TIMESTAMP')}`;\nvoid rows;",
    ],
    invalid: [
      {
        code: "async function sql(strings: TemplateStringsArray, ...values: unknown[]) { return String.raw({ raw: strings }, ...values); }\ndeclare const id: string;\nconst row = sql`SELECT * FROM users WHERE id = ${id}`;\nvoid row;",
        errors: [{ message: /Do not interpolate values into SQL strings/u }],
      },
      {
        code: "interface SqlTag { (strings: TemplateStringsArray, ...values: unknown[]): { text: string; values: unknown[] }; raw(value: string): { text: string; values: unknown[] }; }\ndeclare const sql: SqlTag;\ndeclare const columnName: string;\nconst rows = sql`SELECT ${sql.raw(columnName)} FROM users`;\nvoid rows;",
        errors: [{ message: /raw SQL builder fragments/u }],
      },
      // A tag whose type depends on a module that does not resolve is undecided, not proven unsafe
      {
        code: "import { Agent } from 'agents-not-installed';\ndeclare const id: string;\nclass Chat extends Agent { load() { return this.sql`SELECT * FROM users WHERE id = ${id}`; } }\nvoid Chat;",
        errors: [
          {
            message:
              /^Incomplete analysis: TypeScript could not resolve 'this\.sql', and this SQL tag's type depends on it/u,
          },
        ],
      },
      {
        code: "import { sql } from 'sql-lib-not-installed';\ndeclare const id: string;\nconst rows = sql`SELECT * FROM users WHERE id = ${id}`;\nvoid rows;",
        errors: [
          {
            message:
              /^Incomplete analysis: TypeScript could not resolve module 'sql-lib-not-installed'/u,
          },
        ],
      },
      {
        code: "declare const sql: any;\ndeclare const id: string;\nconst rows = sql`SELECT * FROM users WHERE id = ${id}`;\nvoid rows;",
        errors: [{ message: /Do not interpolate values into SQL strings/u }],
      },
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
  }
);

// ─── no-appeasement-erasure fixture suite ─────────────────────────────────────
// Fires when a known type is widened to a broad contract, including local flows
// that later re-establish a narrower contract.
typedRuleTester.run("no-appeasement-erasure", rule("no-appeasement-erasure"), {
  valid: [
    fixture("programs/correct/appeasement-erasure-real-boundaries.ts"),
    // Effect decode of a genuine unknown boundary stays clean
    fixture("programs/correct/effect-decode-boundaries.ts"),
    // unknown/any parameters are real boundaries, not erasures
    fixture("programs/correct/parse-as-cast-boundary-inputs.ts"),
    // External SDK result parsed directly — no erased binding involved
    fixture("programs/correct/zod-external-call-boundary.ts"),
  ],
  invalid: [
    // Erased-then-parsed and erased-then-cast, the two IPC edge shapes
    {
      ...fixture("programs/drift/appeasement-erasure-ipc-result.ts"),
      errors: [
        { message: /Appeasement erasure/u },
        { message: /Appeasement erasure/u },
        { message: /Appeasement erasure/u },
      ],
    },
    // Erasure re-established through a curried Effect Schema decoder
    { ...fixture("programs/drift/effect-decode-erasure.ts"), errors: 1 },
  ],
});

typedRuleTester.run(
  "no-identity-schema-transform",
  rule("no-identity-schema-transform"),
  {
    valid: [
      fixture(
        "programs/correct/identity-schema-transform-trust-boundary-decoder.ts"
      ),
      fixture("programs/correct/identity-schema-transform-drops-key.ts"),
      fixture("programs/correct/identity-schema-transform-adds-key.ts"),
      fixture("programs/correct/identity-schema-transform-renames-key.ts"),
      fixture(
        "programs/correct/identity-schema-transform-non-object-output.ts"
      ),
      fixture("programs/correct/identity-schema-transform-non-zod-receiver.ts"),
      fixture("programs/correct/identity-schema-transform-array-map.ts"),
      fixture(
        "programs/correct/identity-schema-transform-unresolved-input-shape.ts"
      ),
      fixture("programs/correct/identity-schema-transform-outside-proof.ts"),
      fixture("programs/correct/identity-schema-transform-readonly.ts"),
      fixture("programs/correct/identity-schema-transform-async.ts"),
    ],
    invalid: [
      {
        ...fixture(
          "programs/drift/identity-schema-transform-reconstruction.ts"
        ),
        errors: [{ messageId: "identitySchemaTransform" }],
      },
      {
        ...fixture("programs/drift/identity-schema-transform-destructured.ts"),
        errors: [{ messageId: "identitySchemaTransform" }],
      },
      {
        ...fixture("programs/drift/identity-schema-transform-block-return.ts"),
        errors: [{ messageId: "identitySchemaTransform" }],
      },
      {
        ...fixture(
          "programs/drift/identity-schema-transform-function-expression.ts"
        ),
        errors: [{ messageId: "identitySchemaTransform" }],
      },
      {
        ...fixture(
          "programs/drift/identity-schema-transform-reordered-keys.ts"
        ),
        errors: [{ messageId: "identitySchemaTransform" }],
      },
    ],
  }
);

typedRuleTester.run(
  "no-explicit-type-arguments-on-owned-api",
  rule("no-explicit-type-arguments-on-owned-api"),
  {
    valid: [fixture("programs/correct/owned-api-explicit-type.ts")],
    invalid: [
      {
        ...fixture("programs/drift/owned-api-explicit-type-convex.ts"),
        errors: [
          { messageId: "explicitTypeArgumentOnOwnedApi" },
          { messageId: "explicitTypeArgumentOnOwnedApi" },
        ],
      },
      {
        ...fixture("programs/drift/owned-api-explicit-type-tanstack.ts"),
        errors: [
          { messageId: "explicitTypeArgumentOnOwnedApi" },
          { messageId: "explicitTypeArgumentOnOwnedApi" },
        ],
      },
    ],
  }
);

typedRuleTester.run(
  "require-convex-return-validator",
  rule("require-convex-return-validator"),
  {
    valid: [
      fixture("programs/correct/convex-returns-validator.ts"),
      fixture("programs/correct/convex-returns-validator-dynamic-config.ts"),
      fixture("programs/correct/convex-returns-validator-local-shadow.ts"),
    ],
    invalid: [
      {
        ...fixture("programs/drift/convex-missing-return-validator.ts"),
        errors: [
          { messageId: "missingReturnValidator" },
          { messageId: "missingReturnValidator" },
        ],
      },
      {
        ...fixture("programs/drift/convex-missing-return-validator-aliased.ts"),
        errors: [{ messageId: "missingReturnValidator" }],
      },
    ],
  }
);

// ─── no-schema-validator-transcoding fixture suite ───────────────────────────
// Fires when an Effect JSONSchema.make result is registered as a Convex
// args/returns validator, directly or through one const binding. Documentation
// sinks and registrations that keep their own validator owner stay clean.
typedRuleTester.run(
  "no-schema-validator-transcoding",
  rule("no-schema-validator-transcoding"),
  {
    valid: [
      fixture("programs/correct/schema-validator-transcoding-documentation.ts"),
    ],
    invalid: [
      {
        ...fixture("programs/drift/schema-validator-transcoding-convex.ts"),
        errors: [
          { messageId: "schemaValidatorTranscoding" },
          { messageId: "schemaValidatorTranscoding" },
        ],
      },
      {
        ...fixture("programs/drift/schema-validator-transcoding-zod.ts"),
        errors: [
          { messageId: "schemaValidatorTranscoding" },
          { messageId: "schemaValidatorTranscoding" },
          { messageId: "schemaValidatorTranscoding" },
        ],
      },
    ],
  }
);

const authzRuleOptions = [{ authzFunctions: ["authorize"] }];

ruleTester.run("require-authz-check", rule("require-authz-check"), {
  valid: [
    {
      ...fixture("programs/correct/authz-before-params.ts"),
      options: authzRuleOptions,
    },
    {
      code: "function handler(req) { const body = req.body; return body; }",
      options: authzRuleOptions,
    },
    {
      code: "function outer(req) { authorize(req.user); }",
      options: authzRuleOptions,
    },
  ],
  invalid: [
    {
      ...fixture("programs/drift/params-without-authz.ts"),
      options: authzRuleOptions,
      errors: 1,
    },
    {
      ...fixture("programs/drift/nested-params-without-local-authz.ts"),
      options: authzRuleOptions,
      errors: 1,
    },
    {
      code: `
        function handler(req) {
          authorize(req.user);
          return req.params.projectId;
        }
      `,
      options: [{ authzFunctions: ["approvedAuthorize"] }],
      errors: 1,
    },
  ],
});

typedRuleTester.run("no-near-duplicate-type", rule("no-near-duplicate-type"), {
  valid: [
    fixture("programs/drift/near-duplicate-type/geometry.ts"),
    fixture("programs/correct/near-duplicate-type/panel.ts"),
    `
      export type Row = { id: string; name: string; status: string };
      export type Ticket = { id: string; name: string; status: "open" | "closed" };
    `,
    `
      export interface Transaction {
        userId: string;
        conversationId: string;
        messageId: string;
        amount: number;
        currency: string;
        model: string;
        endpoint: string;
      }
      export interface MessageFilter {
        userId: string;
        conversationId: string;
        messageId: string;
      }
    `,
    `
      export interface Bounds { left: number; top: number; width: number; height: number }
      export interface Box extends Bounds { id: string; left: number; top: number; width: number }
    `,
    `
      export interface Lifecycle {
        close(input: { showExit: boolean; title?: string; sessionId?: string }): Promise<void>;
      }
      export function createLifecycle(): Lifecycle {
        const close = async (next: { showExit: boolean; title?: string; sessionId?: string }) => {
          void next;
        };
        return { close };
      }
    `,
    `
      export interface BindingAccess {
        binding: string;
        accountId?: never;
        apiToken?: never;
        gateway: string;
      }
      export interface AccountAccess {
        binding?: never;
        accountId: string;
        apiToken: string;
        gateway: string;
      }
    `,
  ],
  invalid: [
    {
      ...fixture("programs/drift/near-duplicate-type/layout.ts"),
      errors: [
        {
          message:
            /^This interface repeats all 4 fields of `Bounds` at \S+geometry\.ts:1\. Extend `Bounds` and declare only the 1 field it adds\.$/u,
        },
      ],
    },
    {
      code: `
        export interface Options {
          staleMs?: number;
          timeoutMs?: number;
          baseDelayMs?: number;
          maxDelayMs?: number;
          signal?: AbortSignal;
          onWait?: () => void;
        }
        type Opts = { staleMs: number; timeoutMs: number; baseDelayMs: number; maxDelayMs: number };
        export const defaults: Opts = { staleMs: 1, timeoutMs: 1, baseDelayMs: 1, maxDelayMs: 1 };
      `,
      errors: [
        {
          message:
            /^This type repeats 4 of the 6 fields of `Options` at \S+:2\. Derive it as Required<Omit<Options, "signal" \| "onWait">>\.$/u,
        },
      ],
    },
    {
      code: `
        export interface Lifecycle {
          close(input: { showExit: boolean; title?: string; sessionId?: string }): Promise<void>;
        }
        class TerminalLifecycle implements Lifecycle {
          async close(next: { showExit: boolean; title?: string; sessionId?: string }) {
            void next;
          }
        }
        export const lifecycle: Lifecycle = new TerminalLifecycle();
      `,
      errors: [
        {
          message:
            /^This parameter type repeats all 3 fields of the `input` parameter of `close` at \S+:3\. Name that type once and use the name in both places\.$/u,
        },
      ],
    },
    {
      code: `
        export type PresentationFileDiff = {
          file?: string;
          patch?: string;
          additions: number;
          deletions: number;
        };
        type LegacyDiff = { file: string; patch?: string; additions: number; deletions: number };
        export const legacy: LegacyDiff[] = [];
      `,
      errors: [
        {
          message:
            /^This type repeats all 4 fields of `PresentationFileDiff` at \S+:2\. Derive it as PresentationFileDiff & Required<Pick<PresentationFileDiff, "file">>\.$/u,
        },
      ],
    },
    {
      code: `
        interface ModelOptions { model: string }
        export interface PiImagesModelOptions extends ModelOptions {
          name?: string;
          width?: number;
          height?: number;
          steps?: number;
        }
        interface ImagesOptions { prompt: string }
        export interface PiImagesCallOptions extends ImagesOptions {
          width?: number;
          height?: number;
          steps?: number;
        }
      `,
      errors: [
        {
          message:
            /^This interface repeats 3 of the 4 fields of `PiImagesModelOptions` at \S+:3\. Extend Pick<PiImagesModelOptions, "width" \| "height" \| "steps"> and drop the 3 fields it repeats\.$/u,
        },
      ],
    },
    {
      code: `
        export interface PullOptions { remote?: string; ref?: string; dir?: string; token?: string; author?: string }
        export interface PushOptions { remote?: string; ref?: string; dir?: string; token?: string; force?: boolean }
      `,
      errors: [
        {
          message:
            /^This interface repeats 4 of the 5 fields of `PullOptions` at \S+:2\. Move the 4 fields they share into one type that both extend, or take them from Pick<PullOptions, "remote" \| "ref" \| "dir" \| "token">\.$/u,
        },
      ],
    },
    {
      code: `
        import type { RetryOptions } from "./missing-module";
        export interface ScheduledTask { name: string; cron: string; retry: RetryOptions }
        export interface ScheduledTaskForTest { name: string; cron: string; retry: RetryOptions }
      `,
      errors: [
        {
          message:
            /^Whether this interface repeats all 3 fields of `ScheduledTask` at \S+:3 is undecided because RetryOptions imported from '\.\/missing-module' \(\S+:2\) at property retry does not resolve\.$/u,
        },
      ],
    },
  ],
});
