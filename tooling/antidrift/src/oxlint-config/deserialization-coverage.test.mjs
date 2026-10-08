import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import tsParser from "@typescript-eslint/parser";
import { ESLint } from "eslint";

import eslintPlugin from "../eslint-plugin/index.js";

const repository = resolve(import.meta.dirname, "../../../..");

let workspace;

beforeAll(() => {
  workspace = mkdtempSync(join(repository, ".deser-matrix-"));
  writeFileSync(
    join(workspace, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { strict: true, target: "ES2022", module: "ESNext" },
      include: ["probe.ts"],
    })
  );
});

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

const probe = `interface StoredUser {
  id: string;
  name: string;
}

declare const text: string;
declare const payload: unknown;
declare function consumeUser(user: StoredUser): void;
declare const UserSchema: {
  parse(value: unknown): StoredUser;
  safeParse(value: unknown): { success: boolean };
};

const assigned: StoredUser = JSON.parse(text);
export const casted = JSON.parse(text) as StoredUser;
consumeUser(JSON.parse(text));
export function read(): StoredUser {
  return JSON.parse(text);
}
JSON.parse(payload);

const raw: unknown = JSON.parse(text);
const user = UserSchema.parse(JSON.parse(text));
const result = UserSchema.safeParse(JSON.parse(text));
void [raw, user, result, assigned];
`;

describe("deserialization coverage matrix", () => {
  it("the ESLint-owned typed lane reports parsed JSON contracts and broad inputs while accepting validated boundaries", async () => {
    const probePath = join(workspace, "probe.ts");
    writeFileSync(probePath, probe);
    const eslint = new ESLint({
      overrideConfigFile: true,
      overrideConfig: [
        {
          files: ["**/*.ts"],
          languageOptions: {
            parser: tsParser,
            parserOptions: {
              projectService: true,
              tsconfigRootDir: workspace,
            },
          },
          plugins: { antidrift: eslintPlugin },
          rules: { "antidrift/no-unsafe-deserialize": "error" },
        },
      ],
    });
    const [result] = await eslint.lintFiles([probePath]);
    const lines = result.messages.map((message) => message.line);
    expect(lines).toEqual([14, 15, 16, 18, 20]);
  }, 120_000);
});
