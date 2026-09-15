import {
  fixture,
  rule,
  ruleTester,
} from "../../test/support/eslint-plugin-harness.mjs";

const imports =
  'import { query, mutation, action, internalQuery, internalMutation, internalAction } from "./_generated/server"; import { v } from "convex/values";';
const errors = [{ messageId: "widenedReturn" }];

ruleTester.run("no-convex-return-widening", rule("no-convex-return-widening"), {
  valid: [
    fixture("convex-return/allows.ts"),
    {
      code: `${imports} export const list = query({ returns: v.array(message), handler: run });`,
    },
    {
      code: `${imports} export const list = query({ args: { data: v.any() }, returns: v.null(), handler: run });`,
    },
    {
      code: `${imports} export const list = query({ handler: () => v.any() });`,
    },
    {
      code: `${imports} export const list = query({ returns: v.any(), handler: run });`,
      options: [{ allows: ["list"] }],
    },
    {
      code: `${imports} export default query({ returns: v.any(), handler: run });`,
      options: [{ allows: ["default"] }],
    },
    {
      code: 'import { query } from "database"; import { v } from "convex/values"; const list = query({ returns: v.any() });',
    },
    {
      code: 'import { query } from "./_generated/server"; const v = factory(); const list = query({ returns: v.any() });',
    },
    {
      code: `${imports} function build(query: Factory) { return query({ returns: v.any() }); }`,
    },
    {
      code: `${imports} function build(v: Validator) { return query({ returns: v.any() }); }`,
    },
    {
      code: `${imports} export const list = query({ returns: v.object({ any: v.string(), nested: v.array(v.number()) }) });`,
    },
    {
      code: `${imports} export const list = query({ returns: createValidator(v.any()) });`,
    },
    {
      code: `${imports} export const list = query({ returns: v.object({}) }); const data = v.any();`,
    },
    {
      code: 'import type { query } from "./_generated/server"; import { v } from "convex/values"; const list = query({ returns: v.any() });',
    },
  ],
  invalid: [
    { ...fixture("convex-return/flags.ts"), errors },
    ...[
      "query",
      "mutation",
      "action",
      "internalQuery",
      "internalMutation",
      "internalAction",
    ].map((builder) => ({
      code: `${imports} export const run = ${builder}({ returns: v.any(), handler: work });`,
      errors,
    })),
    {
      code: `${imports} export const list = query({ returns: v.object({ data: v.any() }), handler: run });`,
      errors,
    },
    {
      code: `${imports} export const list = query({ returns: v.array(v.array(v.any())), handler: run });`,
      errors,
    },
    {
      code: `${imports} export const list = query({ returns: v.optional(v.object({ data: v.union(v.string(), v.any()) })) });`,
      errors,
    },
    {
      code: `${imports} export const list = query({ returns: v.record(v.string(), v.any()) });`,
      errors,
    },
    {
      code: 'import { query as defineQuery } from "../_generated/server.js"; import { v as validate } from "convex/values"; export const list = defineQuery({ returns: validate.any() });',
      errors,
    },
    {
      code: 'import * as api from "./_generated/server"; import * as values from "convex/values"; export const list = api.query({ returns: values.v.any() });',
      errors,
    },
    {
      code: `${imports} export const list = query({ "returns": v["any"]() });`,
      errors,
    },
    {
      code: `${imports} export const list = query(({ returns: v.any() } satisfies Definition));`,
      errors,
    },
    {
      code: `${imports} export const list = query({ returns: v.object({ first: v.any(), second: v.any() }) });`,
      errors,
    },
    {
      code: `${imports} export const registry = { list: query({ returns: v.any() }) };`,
      errors,
    },
  ],
});
