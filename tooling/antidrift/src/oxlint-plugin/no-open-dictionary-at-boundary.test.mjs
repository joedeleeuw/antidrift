import {
  fixture,
  rule,
  ruleTester,
} from "../../test/support/eslint-plugin-harness.mjs";

const errors = [{ messageId: "openBoundary" }];

ruleTester.run(
  "no-open-dictionary-at-boundary",
  rule("no-open-dictionary-at-boundary"),
  {
    valid: [
      fixture("open-dictionary/allows.ts"),
      {
        code: "function receive(input: Record<string, unknown>): Record<string, any> { return input; }",
      },
      {
        code: "const data: { [key: string]: unknown } = {}; export function read() { const local: Record<string, any> = {}; return local; }",
      },
      {
        code: "export const headers: Record<string, unknown> = {};",
        options: [{ allows: ["headers"] }],
      },
      {
        code: "const bag: Record<string, any> = {}; export { bag as headers };",
        options: [{ allows: ["headers"] }],
      },
      {
        code: "export default function(input: Record<string, any>) {}",
        options: [{ allows: ["default"] }],
      },
      { code: 'export const values: Record<"name" | "title", unknown> = {};' },
      { code: "export let values: { [key: number]: unknown };" },
      { code: "export function headers(input: Record<string, string>) {}" },
      {
        code: "type Bag = Record<string, unknown>; export const bag: Bag = {};",
      },
      {
        code: "type Record<K, V> = { key: K; value: V }; export const pair: Record<string, unknown> = makePair();",
      },
      {
        code: 'import { Record } from "records"; export const bag: Record<string, unknown> = makeBag();',
      },
      { code: 'export { data } from "./internal";' },
    ],
    invalid: [
      { ...fixture("open-dictionary/flags.ts"), errors },
      {
        code: "export function receive(input: Record<string, any>) {}",
        errors,
      },
      {
        code: "export function receive(input: { [key: string]: unknown }) {}",
        errors,
      },
      {
        code: "export function receive(): { [key: string]: any } { return {}; }",
        errors,
      },
      { code: "export const data: Record<string, unknown> = {};", errors },
      { code: "export let data: Record<string, any>;", errors },
      { code: "export var data: { [key: string]: unknown };", errors },
      {
        code: "export const receive = (input: Record<string, unknown>) => input;",
        errors,
      },
      {
        code: "export const receive = function(): Promise<Record<string, any>> { return fetchData(); };",
        errors,
      },
      {
        code: "const data: Record<string, unknown> = {}; export { data };",
        errors,
      },
      {
        code: "export { receive }; function receive(input: Record<string, unknown>) {}",
        errors,
      },
      {
        code: "const data: Record<string, unknown> = {}; export default data;",
        errors,
      },
      {
        code: "export default (input: Record<string, unknown>) => input;",
        errors,
      },
      {
        code: "export default function receive(): Record<string, unknown> { return {}; }",
        errors,
      },
      {
        code: "export declare function receive(input: Record<string, unknown>): void;",
        errors,
      },
      {
        code: "export function receive(input: { metadata: Readonly<Record<string, unknown>> } = {}) {}",
        errors,
      },
      {
        code: "export const receive: (input: Record<string, unknown>) => void = work;",
        errors,
      },
      {
        code: "const bag: Record<string, any> = {}; export { bag as headers, bag as payload };",
        options: [{ allows: ["headers"] }],
        errors,
      },
    ],
  },
);
