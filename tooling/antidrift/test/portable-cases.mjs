import { portableRuleCases } from "./portable-rule-cases.mjs";
import { boundaryCoreHeadlessProbes } from "./portable-boundary-probes.mjs";
import { directiveCoreHeadlessProbes } from "./portable-directive-probes.mjs";
import { contractCoreHeadlessProbes } from "./portable-contract-probes.mjs";
import { reactCoreHeadlessProbes } from "./portable-react-probes.mjs";

export const portableCases = [...portableRuleCases];

const sharedHelperSources = {
  "tooling/antidrift/src/__probe_helpers.ts": `
      declare const Context: {
        Tag: (id: string) => <Self, Shape>() => { new (): Self; of: (s: Shape) => Shape; pipe: (...fns: unknown[]) => unknown };
      };
      declare const Layer: { succeed: <T, S>(tag: T, s: S) => unknown };
      export interface UsersRepoShape { findById(id: string): string; count(): number }
      export class UsersRepo extends Context.Tag("UsersRepo")<UsersRepo, UsersRepoShape>() {}
      export const parseUserId = (raw: string): string => raw.trim();
      export const makeUsersRepo = (): UsersRepoShape => ({ findById: (id) => parseUserId(id), count: () => 1 });
      export const requireUsersScope = (): UsersRepoShape => { void UsersRepo.pipe(); return { findById: (id) => id, count: () => 0 }; };
      export const refineUsersScope = (scope: UsersRepoShape): UsersRepoShape => scope;
      export const UsersRepoLive = Layer.succeed(UsersRepo, makeUsersRepo());
      export function relativeAge(updatedAt: number, now = Date.now()): number { return now - updatedAt; }
      export function formatNow(): number { return Date.now(); }
    `,
  "tooling/antidrift/src/__probe_seam_fakes.mock.ts": `
      import type { Ticker } from "./__probe_seam_multi.js";
      import { runGit, Stamp } from "./__probe_seam_runner.js";
      export const fakeTicker: Ticker = { tick: () => 1 };
      runGit(["log"], () => Buffer.from(""));
      new Stamp(() => 1).at();
    `,
  "tooling/antidrift/src/__probe_use_platform.native.ts": `
      import { useState } from "react";
      export function useNativeBiometrics() {
        const [supported] = useState(true);
        return { supported };
      }
    `,
  "tooling/antidrift/src/node_modules/convex/server.ts": `
      export function query<Args, Returns>(config: { args?: Args; returns?: Returns; handler: (...a: never[]) => unknown }): typeof config {
        return config;
      }
    `,
  "tooling/antidrift/src/node_modules/convex/values.ts": `
      export const v = {
        string: () => "string" as const,
        null: () => null,
        any: () => "any" as const,
        object: <T>(fields: T): T => fields,
      };
    `,
  "tooling/antidrift/src/node_modules/@valibot/to-json-schema/index.ts": `
      export function toJsonSchema<T>(schema: T): T {
        return schema;
      }
    `,
  "tooling/antidrift/src/node_modules/valibot/index.ts": `
      export const v = {
        string: () => ({ kind: "string" as const }),
        pipe: <S, R>(schema: S, action: (input: S) => R): R => action(schema),
        transform: <I, O>(fn: (input: I) => O) => (schema: I): O => fn(schema),
      };
    `,
  "tooling/antidrift/src/node_modules/swr/index.ts": `
      export function useSWR<Data>(key: string, fetcher: (key: string) => Promise<Data>): Data {
        void key;
        void fetcher;
        return undefined as never;
      }
    `,
};

export function buildSharedHelperFiles(repoRoot, resolve) {
  return Object.fromEntries(
    Object.entries(sharedHelperSources).map(([file, text]) => [
      resolve(repoRoot, file),
      text,
    ])
  );
}

export const coreHeadlessProbes = [
  ...boundaryCoreHeadlessProbes,
  ...directiveCoreHeadlessProbes,
  ...contractCoreHeadlessProbes,
  ...reactCoreHeadlessProbes,
];
