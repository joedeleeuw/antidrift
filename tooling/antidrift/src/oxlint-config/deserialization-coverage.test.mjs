import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import tsParser from "@typescript-eslint/parser";
import { ESLint } from "eslint";

import eslintPlugin from "../eslint-plugin/index.js";

import {
  createGovernanceOxlintConfig,
  typescriptBaselineTier,
} from "./index.mjs";

const packageRequire = createRequire(import.meta.url);
const repository = resolve(import.meta.dirname, "../../../..");
const oxlintBin = join(
  dirname(packageRequire.resolve("oxlint/package.json")),
  "bin",
  "oxlint",
);

let workspace;

beforeAll(() => {
  workspace = mkdtempSync(join(repository, ".deser-matrix-"));
  writeFileSync(
    join(workspace, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { strict: true, target: "ES2022", module: "ESNext" },
      include: ["probe.ts"],
    }),
  );
  const config = createGovernanceOxlintConfig({ repoRoot: repository });
  writeFileSync(
    join(workspace, "oxlint.config.mjs"),
    `export default ${JSON.stringify({ ...config, options: { ...config.options, typeAware: true } }, null, 2)};\n`,
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
  it.skipIf(typescriptBaselineTier(repository) !== "full")(
    "the combined stack reports every unsafe result path and stays clean at boundaries",
    () => {
      const probePath = join(workspace, "probe.ts");
      writeFileSync(probePath, probe);
      const result = spawnSync(
        process.execPath,
        [oxlintBin, "--config", join(workspace, "oxlint.config.mjs"), probePath],
        { cwd: repository, encoding: "utf8" },
      );
      if (result.error) throw result.error;
      const output = `${result.stdout}${result.stderr}`;

      const findings = output
        .split("\n")
        .filter((line) => /probe\.ts:\d+:\d+:/u.test(line));
      const rulesAt = (line) =>
        findings
          .filter((finding) => finding.includes(`probe.ts:${line}:`))
          .map((finding) => {
            const match = /(\w+)\(([^()]+)\):/u.exec(finding);
            return match ? `${match[1]}/${match[2]}` : undefined;
          });

      expect(rulesAt(14)).toContain("typescript/no-unsafe-assignment");
      expect(rulesAt(15)).toContain("typescript/no-unsafe-type-assertion");
      expect(rulesAt(16)).toContain("typescript/no-unsafe-argument");
      expect(rulesAt(18)).toContain("typescript/no-unsafe-return");

      expect(rulesAt(22)).toEqual([]);
      expect(rulesAt(23)).toEqual([]);
      expect(rulesAt(24)).toEqual([]);
    },
    120_000,
  );

  it("the ESLint-owned typed lane reports broad-input JSON.parse and stays clean at boundaries", async () => {
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
    expect(lines).toEqual([20]);
  }, 120_000);
});
