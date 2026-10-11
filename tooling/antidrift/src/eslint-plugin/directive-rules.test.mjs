import { rule, ruleTester } from "../../test/support/eslint-plugin-harness.mjs";

ruleTester.run("no-pass-through-parameters", rule("no-pass-through-parameters"), {
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
      errors: [{ messageId: "passThrough", data: { name: "db", targets: "'queryEvents'" } }],
    },
    {
      code: "import { Card } from '@/components/card'; export function DocumentList({ documents, className }) { return <Card className={className}>{documents.length}</Card>; }",
      errors: [{ messageId: "passThrough", data: { name: "className", targets: "'Card'" } }],
    },
    {
      code: "import { Button } from './button'; export function IconButton({ icon, ...rest }) { return <Button {...rest}>{icon}</Button>; }",
      errors: [{ messageId: "passThrough", data: { name: "rest", targets: "'Button'" } }],
    },
    {
      code: "class Runner { run(command, cwd) { this.log(command); return this.spawn({ cwd, args: command.split(' ') }); } }",
      errors: [{ messageId: "passThrough", data: { name: "cwd", targets: "'this.spawn'" } }],
    },
  ],
});

ruleTester.run("no-compat-names", rule("no-compat-names"), {
  valid: [
    "type OpenAICompatibleModelId = string;",
    "function readConfig() {}",
    "const settings = { legacyMode: true };",
    "import { legacyLoader } from './loader';",
  ],
  invalid: [
    { code: "function readLegacyConfig() {}", errors: [{ messageId: "compatName", data: { name: "readLegacyConfig" } }] },
    { code: "const deprecatedPaths = [];", errors: 1 },
    { code: "function load(compatMode) { return compatMode; }", errors: 1 },
    { code: "interface RetiredRule { id: string }", errors: 1 },
    { code: "class Store { migrateLegacy() {} noLongerUsed = 1; }", errors: 2 },
    { code: "type Options = { compatibilityDate: string };", errors: 1 },
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
  ],
  invalid: [
    { code: "const data = load();", errors: [{ messageId: "vague", data: { name: "data", reason: "a vague noun" } }] },
    { code: "const res2 = load();", errors: 1 },
    { code: "try { run(); } catch (e) { report(e); }", errors: [{ messageId: "vague", data: { name: "e", reason: "an abbreviation of 'error or event'" } }] },
    { code: "items.sort((a, b) => a.rank - b.rank);", errors: 2 },
    { code: "const userData = load();", errors: [{ messageId: "vague", data: { name: "userData", reason: "a filler suffix" } }] },
    { code: "const myClient = connect();", errors: [{ messageId: "vague", data: { name: "myClient", reason: "a filler prefix" } }] },
    { code: "function handle(props) { return props.id; }", errors: 1 },
    { code: "const { value } = field;", errors: 1 },
    { code: "export function load(ctx, value) { return ctx.db.get(value); }", errors: 2 },
  ],
});

const hash = "ab".repeat(32);

ruleTester.run("no-hash-literal", rule("no-hash-literal"), {
  valid: [
    `const encryptionKey = "${hash}";`,
    `expect(identityHash(input)).toBe(\`${hash}\`.slice(1));`,
  ],
  invalid: [
    { code: `const patchSha256 = "${hash}";`, errors: 1 },
    { code: `const source = { sha256: "${hash}" };`, errors: 1 },
    { code: `if (digest !== "${hash}") fail();`, errors: 1 },
  ],
});

ruleTester.run("no-host-path-literal", rule("no-host-path-literal"), {
  valid: [
    { code: 'const brew = "/home/linuxbrew/.linuxbrew/bin";', filename: "scripts/path.ts" },
    { code: 'const root = "/Users/alex/repos/project";', filename: "src/paths.test.ts" },
  ],
  invalid: [
    { code: "const root = `/Users/joe/code/${name}`;", filename: "scripts/path.ts", errors: 1 },
  ],
});

ruleTester.run("no-dated-comments", rule("no-dated-comments"), {
  valid: [
    'expect(cards[0]).toHaveTextContent("SPEC-002"); // 2024-01-21',
    '/** Matches lines like updated_at: "2025-01-01 10:00:00". */\nstart();',
  ],
  invalid: [
    { code: "/** A court docket. Verified live 2026-08-14. */\nstart();", errors: 1 },
  ],
});

ruleTester.run("no-fallback-to-empty", rule("no-fallback-to-empty"), {
  valid: [
    'function readRegistry(path) { try { return parse(read(path)); } catch (error) { if (error.code === "ENOENT") return {}; throw error; } }',
    "function readRegistry(path) { try { return parse(read(path)); } catch (error) { errors.push(error.message); return {}; } }",
  ],
  invalid: [
    { code: "function readRegistry(path) { try { return parse(read(path)); } catch (error) { return {}; } }", errors: 1 },
    { code: "const body = await response.json().catch(() => ({}));", errors: 1 },
  ],
});

ruleTester.run("no-else-if-chain", rule("no-else-if-chain"), {
  valid: [
    'if (mode === "a") run(1); else if (mode === "b") run(2); else if (mode === "c") run(3);',
  ],
  invalid: [
    {
      code: 'if (event.key === "Up" || event.key === "Left") up(); else if (event.key === "Down") down(); else if (event.key === "Enter") open(); else if (event.key === "Escape") close(); else idle();',
      errors: [{ messageId: "chain", data: { count: 4, discriminant: "event.key" } }],
    },
  ],
});
