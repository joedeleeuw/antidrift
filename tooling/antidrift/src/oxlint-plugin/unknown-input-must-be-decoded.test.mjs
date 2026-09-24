import {
  fixture,
  fixturesDir,
  rule,
  ruleTester,
} from "../../test/support/eslint-plugin-harness.mjs";

const predicate =
  "declare function isMessage(value: unknown): value is Message;";
const assertion =
  "declare function assertMessage(value: unknown): asserts value is Message;";
const filename = `${fixturesDir}/unknown-input/consumer.ts`;
const errors = [{ messageId: "decodeUnknown" }];

ruleTester.run(
  "unknown-input-must-be-decoded",
  rule("unknown-input-must-be-decoded"),
  {
    valid: [
      {
        code: "function receive({ title }: unknown, count: number) { use(title, count); }",
        options: [{ allows: ["title"] }],
      },
      fixture("unknown-input/allows.ts"),
      {
        code: "function receive(input: unknown) { return decodeMessage(input); }",
      },
      {
        code: "function receive(input: unknown) { return schema.safeParse(input); }",
      },
      {
        code: "const input: unknown = read(); const message = validateMessage(input); use(message);",
      },
      {
        code: "function receive(input: unknown = read()) { return parser.parse(input); }",
      },
      {
        code: "try { work(); } catch (error: unknown) { console.log(error); }",
      },
      {
        code: "promise.catch((reason: unknown) => console.error(reason));",
      },
      {
        code: "promise.then(() => 1, (reason: unknown) => console.error(reason));",
      },
      {
        code: "function respond(body: unknown) { return Response.json(body); }",
      },
      {
        code: "function write(body: unknown) { stream.end(JSON.stringify(body)); }",
      },
      {
        code: "function record(value: unknown) { return JSON.stringify(value, null, 2); }",
      },
      {
        code: "function receive(input: unknown) { console.log(input); }",
        options: [{ allows: ["input"] }],
      },
      { code: "function receive(input: unknown) {}" },
      {
        code: `${predicate} function receive(input: unknown) { if (isMessage(input)) use(input.title); }`,
      },
      {
        code: `${predicate} function receive(input: unknown) { if (!isMessage(input)) throw new Error("invalid"); use(input.title); }`,
      },
      {
        code: `${predicate} function receive(input: unknown) { if (!isMessage(input)) { return; } use(input.title); }`,
      },
      {
        code: `${predicate} function receive(input: unknown) { return isMessage(input) ? input.title : "invalid"; }`,
      },
      {
        code: `${predicate} function receive(input: unknown) { return isMessage(input) && input.title; }`,
      },
      {
        code: `${predicate} function receive(input: unknown) { return !isMessage(input) || input.title; }`,
      },
      {
        code: `${predicate} function receive(input: unknown) { if (isMessage(input) && ready()) use(input); }`,
      },
      {
        code: `${assertion} function receive(input: unknown) { assertMessage(input); use(input); }`,
      },
      {
        code: `${predicate} function receive(input: unknown) { while (isMessage(input)) { use(input); input = read(); } }`,
      },
      {
        code: `${predicate} function receive(input: unknown) { if (isMessage(input)) { run(() => use(input)); } }`,
      },
      {
        code: `${predicate} function receive(input: unknown) { if (isMessage(input)) {} else { useDefault(); return; } use(input); }`,
      },
      {
        code: 'import { isMessage as check } from "./predicates"; function receive(input: unknown) { if (check(input)) use(input); }',
        filename,
      },
      {
        code: 'import { assertMessage } from "./predicates.js"; function receive(input: unknown) { assertMessage(input); use(input); }',
        filename,
      },
      {
        code: "const check = (value: unknown): value is Message => validateMessage(value); function receive(input: unknown) { if (check(input)) use(input); }",
      },
      {
        code: "declare const check: (value: unknown) => value is Message; function receive(input: unknown) { if (check(input)) use(input); }",
      },
      {
        code: `${predicate} const input: unknown = read(); function other(input: string) { use(input); } schema.parse(input);`,
      },
    ],
    invalid: [
      {
        code: "class Handler { constructor(private input: unknown) { use(input); } }",
        errors,
      },
      { code: "function receive({ title }: unknown) { use(title); }", errors },
      { code: "const [value]: unknown = read(); use(value);", errors },
      { ...fixture("unknown-input/flags.ts"), errors },
      { code: "const input: unknown = read(); use(input);", errors },
      {
        code: "function receive(input: unknown) { return input as Message; }",
        errors,
      },
      {
        code: "function receive(input: unknown) { schema.parse(input); return input; }",
        errors,
      },
      {
        code: "function receive(input: unknown) { use(input); schema.parse(input); }",
        errors,
      },
      {
        code: "function receive(input: unknown) { if (input) use(input); }",
        errors,
      },
      {
        code: "function receive(input: unknown) { return schema.parse(input.payload); }",
        errors,
      },
      {
        code: "function receive(input: unknown = read()) { use(input); }",
        errors,
      },
      {
        code: "promise.then((value: unknown) => use(value));",
        errors,
      },
      {
        code: 'function receive(payload: unknown) { if (typeof payload === "object" && payload !== null && "error" in payload) return payload.error; return null; }',
        errors,
      },
      {
        code: "function receive(body: unknown) { JSON.stringify(body); return body.length; }",
        errors,
      },
      {
        code: "function receive(body: unknown) { JSON.stringify(body); return body; }",
        errors,
      },
      {
        code: `${predicate} function receive(input: unknown) { isMessage(input); use(input); }`,
        errors,
      },
      {
        code: `${predicate} function receive(input: unknown) { if (isMessage(input)) {} use(input); }`,
        errors,
      },
      {
        code: `${predicate} function receive(input: unknown) { if (isMessage(input)) {} else use(input); }`,
        errors,
      },
      {
        code: `${predicate} function receive(input: unknown) { if (isMessage(input) || ready()) use(input); }`,
        errors,
      },
      {
        code: `${predicate} function receive(input: unknown) { if (!isMessage(input)) report(); use(input); }`,
        errors,
      },
      {
        code: `${predicate} function receive(input: unknown) { if (isMessage(input)) { input = read(); use(input); } }`,
        errors,
      },
      {
        code: `${assertion} function receive(input: unknown) { assertMessage(input); input = read(); use(input); }`,
        errors,
      },
      {
        code: `${predicate} function receive(input: unknown) { if (isMessage(input)) { while (ready()) { use(input); input = read(); } } }`,
        errors,
      },
      {
        code: `${predicate} function receive(input: unknown) { if (isMessage(input)) { run(() => use(input)); input = read(); } }`,
        errors,
      },
      {
        code: "declare function looksValid(input: unknown): boolean; function receive(input: unknown) { if (looksValid(input)) use(input); }",
        errors,
      },
      {
        code: 'import { looksValid } from "./predicates"; function receive(input: unknown) { if (looksValid(input)) use(input); }',
        filename,
        errors,
      },
      {
        code: `${predicate} function receive(input: unknown) { use(input); if (isMessage(input)) use(input); }`,
        errors,
      },
      {
        code: `${predicate} function receive(input: unknown) { if (isMessage?.(input)) use(input); }`,
        errors,
      },
      {
        code: `${predicate} function receive(input: unknown) { if (isMessage(other)) use(input); }`,
        errors,
      },
    ],
  },
);
