import { resolve } from "node:path";

import {
  fixturesDir,
  rule,
  ruleTester,
  typedRuleTester,
} from "../../test/support/eslint-plugin-harness.mjs";

ruleTester.run(
  "no-pass-through-parameters",
  rule("no-pass-through-parameters"),
  {
    valid: [
      "import { save } from './store'; function persist(user) { validate(user); return save(user); }",
      "import { measure } from './geometry'; function area(shape) { const size = measure(shape); return size.width * size.height; }",
      "function Badge({ label, ...rest }) { return <span {...rest}>{label}</span>; }",
      "function report(error) { console.error(error); }",
      "items.map((item) => render(item)); function render(entry) { return entry.name; }",
      "import { write } from './review'; useMutation({ mutationFn: (input) => write(input) });",
      "import { load } from 'remote-sdk'; function fetchUser(id) { return load(id); }",
    ],
    invalid: [
      {
        code: "import { queryEvents } from './events'; export function listEvents(db, filter) { if (!filter.kind) return []; return queryEvents(db, filter); }",
        errors: [
          {
            messageId: "passThrough",
            data: { name: "db", targets: "'queryEvents'" },
          },
        ],
      },
      {
        code: "import { Card } from '@/components/card'; export function DocumentList({ documents, className }) { return <Card className={className}>{documents.length}</Card>; }",
        errors: [
          {
            messageId: "passThrough",
            data: { name: "className", targets: "'Card'" },
          },
        ],
      },
      {
        code: "import { Button } from './button'; export function IconButton({ icon, ...rest }) { return <Button {...rest}>{icon}</Button>; }",
        errors: [
          {
            messageId: "passThrough",
            data: { name: "rest", targets: "'Button'" },
          },
        ],
      },
      {
        code: "class Runner { run(command, cwd) { this.log(command); return this.spawn({ cwd, args: command.split(' ') }); } }",
        errors: [
          {
            messageId: "passThrough",
            data: { name: "cwd", targets: "'this.spawn'" },
          },
        ],
      },
      {
        code: "import { save } from './store'; function forward(entry) { void save(entry); }",
        errors: [{ messageId: "passThrough" }],
      },
      {
        code: "const save = ((entry) => entry) satisfies ((entry: string) => string); function forward(entry: string) { return save(entry); }",
        errors: [{ messageId: "passThrough" }],
      },
    ],
  }
);

ruleTester.run("no-compat-names", rule("no-compat-names"), {
  valid: [
    "type OpenAICompatibleModelId = string;",
    "function readConfig() {}",
    "const settings = { legacyMode: true };",
    "import { legacyLoader } from './loader';",
  ],
  invalid: [
    {
      code: "function readLegacyConfig() {}",
      errors: [{ messageId: "compatName", data: { name: "readLegacyConfig" } }],
    },
    { code: "const deprecatedPaths = [];", errors: 1 },
    { code: "function load(compatMode) { return compatMode; }", errors: 1 },
    { code: "interface RetiredRule { id: string }", errors: 1 },
    { code: "class Store { migrateLegacy() {} noLongerUsed = 1; }", errors: 2 },
    { code: "type Options = { compatibilityDate: string };", errors: 1 },
    { code: "const { legacyPath } = settings;", errors: 1 },
    { code: "function load({ compatMode }) { return compatMode; }", errors: 1 },
  ],
});

ruleTester.run("no-vague-names", rule("no-vague-names"), {
  valid: [
    "const invoices = load();",
    "for (let i = 0; i < n; i += 1) {}",
    "const points = rows.map((x, y) => x + y);",
    "function Profile(props) { return <div>{props.name}</div>; }",
    "const Panel = (props) => <section>{props.children}</section>;",
    "const formData = new FormData(form);",
    "const tempDir = mkdtempSync(prefix);",
    "const { data: invoices } = useQuery(query);",
    "const X = horizontal;",
    "const tmp_path = mkdtempSync(prefix);",
    "const TempDir = mkdtempSync(prefix);",
    "function load(ctx: QueryCtx) { return ctx.db; }",
    "type DatabaseCtx = QueryCtx | MutationCtx; function load(ctx: DatabaseCtx) { return ctx.db; }",
    "function load(ctx: QueryCtx | MutationCtx) { return ctx.db; }",
    "function load(ctx: GenericQueryCtx<DataModel>) { return ctx.db; }",
    "function load(ctx: Convex.QueryCtx) { return ctx.db; }",
  ],
  invalid: [
    { code: "function load(ctx: Request) { return ctx.url; }", errors: 1 },
    {
      code: "function load(ctx: Ctxless<Model>) { return ctx.url; }",
      errors: 1,
    },
    { code: 'const ctx = canvas.getContext("2d");', errors: 1 },
    {
      code: "const data = load();",
      errors: [
        { messageId: "vague", data: { name: "data", reason: "a vague noun" } },
      ],
    },
    { code: "const res2 = load();", errors: 1 },
    {
      code: "try { run(); } catch (e) { report(e); }",
      errors: [
        { messageId: "vague", data: { name: "e", reason: "a single letter" } },
      ],
    },
    {
      code: "fetch(url).catch((err) => report(err));",
      errors: [
        {
          messageId: "vague",
          data: { name: "err", reason: "an abbreviation of 'error'" },
        },
      ],
    },
    { code: "items.sort((a, b) => a.rank - b.rank);", errors: 2 },
    {
      code: "const userData = load();",
      errors: [
        {
          messageId: "vague",
          data: { name: "userData", reason: "a filler suffix" },
        },
      ],
    },
    {
      code: "const myClient = connect();",
      errors: [
        {
          messageId: "vague",
          data: { name: "myClient", reason: "a filler prefix" },
        },
      ],
    },
    { code: "function handle(items) { return items.length; }", errors: 1 },
    { code: "const result = run(); const contents = read();", errors: 2 },
    { code: "const { value } = field;", errors: 1 },
    {
      code: "export function load(ctx, value) { return ctx.db.get(value); }",
      errors: 2,
    },
    { code: "const DATA = load();", errors: 1 },
    { code: "const user_data = load();", errors: 1 },
    { code: "const my_config = load();", errors: 1 },
    {
      code: "const req2 = request;",
      errors: [
        {
          messageId: "vague",
          data: { name: "req2", reason: "an abbreviation of 'request'" },
        },
      ],
    },
    {
      code: "function normalize(props) { return Object.keys(props); }",
      errors: [
        {
          messageId: "vague",
          data: { name: "props", reason: "an abbreviation of 'properties'" },
        },
      ],
    },
  ],
});

typedRuleTester.run("no-vague-names", rule("no-vague-names"), {
  valid: [
    {
      code: `
        type QueryCtx = { db: string };
        declare function query(handler: (ctx: QueryCtx) => string): void;
        query((ctx) => ctx.db);
      `,
      filename: resolve(fixturesDir, "vague-context-inferred.ts"),
    },
    {
      code: `
        type GenericQueryCtx<Model> = { db: Model };
        declare function query(handler: (ctx: GenericQueryCtx<string> | null) => string): void;
        query((ctx) => ctx?.db ?? "");
      `,
      filename: resolve(fixturesDir, "vague-context-generic.ts"),
    },
  ],
  invalid: [
    {
      code: `
        declare function run(handler: (ctx: number) => number): void;
        run((ctx) => ctx + 1);
      `,
      filename: resolve(fixturesDir, "vague-context-number.ts"),
      errors: 1,
    },
    {
      code: `
        type Request = { url: string };
        declare function run(handler: (ctx: Request) => string): void;
        run((ctx) => ctx.url);
      `,
      filename: resolve(fixturesDir, "vague-context-request.ts"),
      errors: 1,
    },
  ],
});

ruleTester.run("no-dated-comments", rule("no-dated-comments"), {
  valid: [
    'expect(cards[0]).toHaveTextContent("SPEC-002"); // 2024-01-21',
    '/** Matches lines like updated_at: "2025-01-01 10:00:00". */\nstart();',
  ],
  invalid: [
    {
      code: "/** A court docket. Verified live 2026-08-14. */\nstart();",
      errors: 1,
    },
  ],
});

ruleTester.run("no-fallback-to-empty", rule("no-fallback-to-empty"), {
  valid: [
    'function readRegistry(path) { try { return parse(read(path)); } catch (error) { if (error.code === "ENOENT") return {}; throw error; } }',
    "function readRegistry(path) { try { return parse(read(path)); } catch (error) { errors.push(error.message); return {}; } }",
    "const body = await read().catch((error) => { log(error); return []; });",
    "const body = await read().catch(() => { const build = () => { return []; }; throw build(); });",
  ],
  invalid: [
    {
      code: "function readRegistry(path) { try { return parse(read(path)); } catch (error) { return {}; } }",
      errors: 1,
    },
    {
      code: "async function load() { try { return await read(); } catch { return [] as Item[]; } }",
      errors: 1,
    },
    {
      code: "async function load() { try { return await read(); } catch { return {} satisfies Record<string, never>; } }",
      errors: 1,
    },
    {
      code: "const body = await read().catch(() => { return []; });",
      errors: 1,
    },
    {
      code: "const body = await read().catch(function () { return {}; });",
      errors: 1,
    },
    {
      code: "const body = await response.json().catch(() => ({}));",
      errors: 1,
    },
  ],
});
