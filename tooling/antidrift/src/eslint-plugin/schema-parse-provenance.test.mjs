import {
  fixture,
  rule,
  ruleTester,
} from "../../test/support/eslint-plugin-harness.mjs";

// ─── no-redundant-zod-parse fixture suite ─────────────────────────────────────
// Canonical-path provenance, no type information: the rule fires only when this
// file produced the value from a validation call on the same canonical schema
// path. Every bail below is silent by design.
ruleTester.run("no-redundant-zod-parse", rule("no-redundant-zod-parse"), {
  valid: [
    // Boundary parse of raw/any input — the legitimate first validation
    fixture("programs/correct/zod-boundary-parse.ts"),
    // Different schema for the storage shape — a genuine second validation
    fixture("programs/correct/zod-different-schema-reparse.ts"),
    // Double JSON.parse — a global receiver has no binding to root a path on
    fixture("programs/correct/zod-non-zod-parse.ts"),
    // Non-schema module receiver with the exact provenance shape
    fixture("programs/correct/zod-non-schema-parse-receiver.ts"),
    // External framework call results are legitimate boundary parses
    fixture("programs/correct/zod-external-call-boundary.ts"),
    // Typed param re-parse — no local provenance (no-parse-as-cast owns it)
    fixture("programs/drift/zod-reparse-typed-value.ts"),
    // Call-result provenance is not decoder provenance: a helper typed as the
    // schema output never proves this schema validated the value.
    fixture("programs/drift/zod-reparse-service-result.ts"),
    fixture("programs/drift/zod-reparse-array-find.ts"),
    fixture("programs/drift/zod-reparse-sync-helper-result.ts"),
    // Bail paths
    fixture("programs/correct/zod-reparse-dynamic-segment.ts"),
    fixture("programs/correct/zod-reparse-reassigned-root.ts"),
    fixture("programs/correct/zod-reparse-mutated-between.ts"),
    fixture("programs/correct/zod-reparse-escaped-into-call.ts"),
    // Escape regressions: the value leaves through a nested expression or a
    // hoisted mutator rather than as a bare call argument
    fixture("programs/correct/zod-reparse-hoisted-mutator-call.ts"),
    fixture("programs/correct/zod-reparse-escape-in-object-literal.ts"),
    fixture("programs/correct/zod-reparse-escape-in-array-literal.ts"),
    fixture("programs/correct/zod-reparse-escape-via-assignment.ts"),
    fixture("programs/correct/zod-reparse-different-path-same-root.ts"),
    fixture("programs/correct/zod-reparse-cross-module-mirror.ts"),
    fixture("programs/correct/zod-safe-parse-data-different-schema.ts"),
    // node:path exposes `parse` with the same provenance shape
    `
      import path from "node:path";
      const first = path.parse("a/b.ts");
      path.parse(first);
    `,
    // A .catch() chain is a different schema instance; the call in the receiver
    // chain means no canonical path exists for it
    `
      import { z } from "zod";
      const S = z.object({ id: z.string() });
      const value = S.parse({ id: "1" });
      S.catch({ id: "fallback" }).parse(value);
    `,
    // Declaring the receiver's module non-schema silences an opaque container
    {
      code: `
        import { registry } from "./registry";
        const value = registry.user.schema.parse({});
        registry.user.schema.parse(value);
      `,
      options: [{ nonSchemaModules: ["./registry"] }],
    },
    // The provenance site is a let binding, so the value may be reassigned
    `
      import { z } from "zod";
      const S = z.object({ id: z.string() });
      let value = S.parse({ id: "1" });
      S.parse(value);
    `,
    // The parse is a schema-contract assertion, not validation drift
    `
      import { z } from "zod";
      const S = z.object({ id: z.string() });
      const value = S.parse({ id: "1" });
      expect(() => S.parse(value)).not.toThrow();
    `,
  ],
  invalid: [
    // Ported: re-parse of a parsed value in the same function
    { ...fixture("programs/drift/zod-reparse-same-fn.ts"), errors: 1 },
    // Ported: re-parse across functions in the same file
    {
      ...fixture("programs/drift/zod-reparse-cross-fn-same-file.ts"),
      errors: 1,
    },
    // Ported: safeParse of a value this schema already validated
    {
      ...fixture("programs/drift/zod-safe-parse-variants.ts"),
      errors: [{ messageId: "alwaysSuccessfulSafeParse" }],
    },
    // Contract seam: member-expression receiver
    {
      ...fixture("programs/drift/zod-reparse-contract-member.ts"),
      errors: [{ messageId: "redundantParse" }],
    },
    // Contract seam: literal computed key
    {
      ...fixture("programs/drift/zod-reparse-contract-computed-key.ts"),
      errors: [{ messageId: "redundantParse" }],
    },
    // Contract seam: const alias of a contract member expands to the same path
    {
      ...fixture("programs/drift/zod-reparse-alias-receiver.ts"),
      errors: [{ messageId: "redundantParse" }],
    },
    // Contract seam: the contract object is imported, so the root is an import
    {
      ...fixture("programs/drift/zod-reparse-imported-contract.ts"),
      errors: [{ messageId: "redundantParse" }],
    },
    // Contract seam: the contract member resolves in-file to the schema binding
    // the other site parses with, so the two paths collapse to one binding
    {
      ...fixture(
        "programs/drift/zod-reparse-contract-holds-schema-binding.ts",
      ),
      errors: [{ messageId: "redundantParse" }],
    },
    // Paired with the escape regressions: a call that only reads, and an object
    // literal that does not carry the value, must still report
    {
      ...fixture("programs/drift/zod-reparse-hoisted-reader-call.ts"),
      errors: [{ messageId: "redundantParse" }],
    },
    {
      ...fixture("programs/drift/zod-reparse-object-literal-without-value.ts"),
      errors: [{ messageId: "redundantParse" }],
    },
    // safeParse provenance flows through the result object and destructuring
    {
      ...fixture("programs/drift/zod-safe-parse-data-reuse.ts"),
      errors: [
        { messageId: "redundantParse" },
        { messageId: "redundantParse" },
      ],
    },
    // A contract package declared through options roots the same seam
    {
      code: `
        import { apiContract } from "@acme/contracts";
        const user = apiContract.getUser.responses[200].parse(raw);
        apiContract.getUser.responses[200].parse(user);
      `,
      options: [{ contractModules: ["@acme/contracts"] }],
      errors: [{ messageId: "redundantParse" }],
    },
    // safeParse of the schema's own unmutated output is dead defensive code
    {
      code: `
        import { z } from "zod";
        const S = z.object({ id: z.string() });
        const value = S.parse({ id: "1" });
        S.safeParse(value);
      `,
      errors: [{ messageId: "alwaysSuccessfulSafeParse" }],
    },
    // parseAsync on both sides of the provenance edge
    {
      code: `
        import { z } from "zod";
        const S = z.object({ id: z.string() });
        export async function run(raw) {
          const value = await S.parseAsync(raw);
          return S.parseAsync(value);
        }
      `,
      errors: [{ messageId: "redundantParse" }],
    },
    // A ts-rest style router literal resolves through the builder argument
    {
      code: `
        import { z } from "zod";
        import { c } from "./client";
        const contract = c.router({
          getPost: { responses: { 200: z.object({ id: z.string() }) } },
        });
        const post = contract.getPost.responses[200].parse(raw);
        contract.getPost.responses[200].parse(post);
      `,
      errors: [{ messageId: "redundantParse" }],
    },
  ],
});
