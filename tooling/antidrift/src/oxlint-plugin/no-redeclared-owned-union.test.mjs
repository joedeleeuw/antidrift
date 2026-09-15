import {
  fixture,
  fixturesDir,
  rule,
  ruleTester,
} from "../../test/support/eslint-plugin-harness.mjs";

const filename = `${fixturesDir}/owned-union/consumer.ts`;
const owner = 'export const PHASES = ["queued", "done"] as const;';
const convex = 'import { v } from "convex/values";';
const errors = [{ messageId: "redeclaredOwner" }];

ruleTester.run("no-redeclared-owned-union", rule("no-redeclared-owned-union"), {
  valid: [
    fixture("owned-union/allows.ts"),
    { code: `${owner} type Phase = "queued" | "other";` },
    {
      code: 'const PHASES = ["queued", "done"] as const; type Phase = "queued" | "done";',
    },
    {
      code: 'export const PHASES = ["queued", "done"]; type Phase = "queued" | "done";',
    },
    {
      code: `${owner} type Phase = "queued" | "done";`,
      options: [{ allows: ["Phase"] }],
    },
    {
      code: `${convex} ${owner} const phase = v.union(v.literal("queued"), v.literal("done"));`,
      options: [{ allows: ["phase"] }],
    },
    {
      code: `${convex} ${owner} const validators = { phase: v.union(v.literal("queued"), v.literal("done")) };`,
      options: [{ allows: ["validators.phase"] }],
    },
    {
      code: `${owner} function f(PHASES: string[]) { type Phase = "queued" | "done"; }`,
    },
    {
      code: 'import type { PHASES } from "./owner"; type Phase = "queued" | "done";',
      filename,
    },
    {
      code: 'import { PHASES } from "./missing"; type Phase = "queued" | "done";',
      filename,
    },
    { code: 'export const CODES = [1, 2] as const; type Code = "1" | "2";' },
    { code: `${owner} type Phase = "queued" | string;` },
    {
      code: `${owner} const v = factory(); const phase = v.union(v.literal("queued"), v.literal("done"));`,
    },
    {
      code: `${convex} ${owner} function f(v: Validator) { return v.union(v.literal("queued"), v.literal("done")); }`,
    },
    {
      code: `${convex} ${owner} const phase = v.union(...PHASES.map(v.literal));`,
    },
  ],
  invalid: [
    {
      code: `function prepare(PHASES: string[]) {} ${owner} type Phase = "queued" | "done";`,
      errors,
    },
    { ...fixture("owned-union/flags.ts"), errors },
    { code: `${owner} type Phase = "done" | "queued" | "queued";`, errors },
    {
      code: 'type Phase = "done" | "queued"; export const PHASES = ["queued", "done"] as const;',
      errors,
    },
    {
      code: 'const phases = ["queued", "done"] as const; export { phases }; type Phase = "done" | "queued";',
      errors,
    },
    {
      code: 'import { PHASES as phases } from "./owner.js"; type Phase = "queued" | "done";',
      filename,
      errors,
    },
    {
      code: 'import * as owner from "./owner"; type Phase = "queued" | "done";',
      filename,
      errors,
    },
    {
      code: 'import labels from "./owner"; type Label = "large" | "small";',
      filename,
      errors,
    },
    {
      code: 'import { CODES } from "./owner"; type Code = 2 | -1 | 0;',
      filename,
      errors,
    },
    {
      code: `${convex} ${owner} const phase = v.union(v.literal("done"), v.literal("queued"));`,
      errors,
    },
    {
      code: 'import { v as validate } from "convex/values"; import { CODES } from "./owner"; const code = validate.union(validate.literal(0), validate.literal(-1), validate.literal(2));',
      filename,
      errors,
    },
  ],
});
