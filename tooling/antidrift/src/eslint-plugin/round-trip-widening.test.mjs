import {
  fixture,
  rule,
  ruleTester,
  typedRuleTester,
} from "../../test/support/eslint-plugin-harness.mjs";

ruleTester.run(
  "no-round-trip-widening type-service guard",
  rule("no-round-trip-widening"),
  {
    valid: [],
    invalid: [
      {
        code: "declare const value: any; value;",
        errors: [{ message: /requires TypeScript parser services/u }],
      },
    ],
  }
);

typedRuleTester.run("no-round-trip-widening", rule("no-round-trip-widening"), {
  valid: [
    fixture("programs/correct/round-trip-widening-controls.ts"),
    // A caller in a file of the same package that the program does not hold is out of view.
    fixture("programs/correct/round-trip-widening-outside/describe.ts"),
    // A test file keeps only the local binding edges: the parameter edge is out of scope there.
    {
      code: `
        function labelOf(input: unknown): string {
          return typeof input === "string" ? input : String(input);
        }
        export const labels = [labelOf("draft"), labelOf("final")];
      `,
      filename: "widening.test.ts",
    },
  ],
  invalid: [
    {
      ...fixture("programs/drift/round-trip-widening-accumulator.ts"),
      errors: [
        {
          message:
            "`properties` is `{ label: { type: string; enum: readonly string[]; descripti…` and 1 other producer, but `Record<string, unknown>` drops the value type `Record<string, unknown>`; the `as` cast at line 19 re-establishes it.",
          line: 10,
        },
      ],
    },
    {
      ...fixture("programs/drift/round-trip-widening-spread-cast.ts"),
      errors: [
        {
          message:
            "`record` is `Part`, but `Record<string, unknown>` drops which `Part` member it is; the `as` cast at line 15 re-establishes it.",
          line: 12,
        },
      ],
    },
    {
      ...fixture("programs/drift/round-trip-widening-parameter-field.ts"),
      errors: [
        {
          message:
            "`result` is `ChatResponseResult`, but `TurnResultLike` drops `message.parts[].text` as `string`; the `typeof` check at line 25 re-establishes it.",
          line: 19,
        },
      ],
    },
    {
      ...fixture("programs/drift/round-trip-widening-recoveries.ts"),
      errors: [
        {
          message:
            /^`change` is `Created`, but `ChangeEvent` drops `kind: "created"`; the `kind` comparison/u,
        },
        {
          message:
            /^`input` is `"draft"` and 1 other producer, but `unknown` drops `string`; the `typeof` check/u,
        },
        {
          message:
            /^`loaded` is `User`, but `any` drops `User`; passing it to `saveUser`/u,
        },
        {
          message:
            /^`config` is `\{ port: number; host: string; \}`, but `object` drops the `port` key; the `in` check/u,
        },
        {
          message:
            /^`failure` is `HttpFailure`, but `Error` drops the key `status`; the `instanceof` check/u,
        },
        {
          message:
            /^`candidate` is `User`, but `unknown` drops `User`; the `isUser` guard/u,
        },
      ],
    },
    // A contract owned by another first-party module anchors at the recovery and names its location.
    {
      ...fixture("programs/drift/round-trip-widening-owner/consumer.ts"),
      errors: [
        {
          message:
            /^`event` is `ClickEvent`, but `LooseEvent` drops `payload` as `\{ x: number; \}`; the `as` cast at line 6 re-establishes it\. `LooseEvent` is declared in .*round-trip-widening-owner\/contract\.ts\.$/u,
          line: 6,
        },
      ],
    },
    // A test file keeps the binding edge.
    {
      code: `
        type Snapshot = { userId: string; signedIn: boolean };
        declare function readSnapshot(): Snapshot;
        export function snapshotUser() {
          const snapshot: unknown = readSnapshot();
          return (snapshot as Snapshot).userId;
        }
      `,
      filename: "widening.test.ts",
      errors: [
        {
          message:
            "`snapshot` is `Snapshot`, but `unknown` drops `Snapshot`; the `as` cast at line 6 re-establishes it.",
        },
      ],
    },
  ],
});
