import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import tsParser from "@typescript-eslint/parser";
import { ESLint } from "eslint";
import "zod";

import { createEslintConfig } from "../src/index.js";

const schemasSource = `
import { z } from "zod";

export const UserSchema = z.object({ id: z.string(), displayName: z.string() });
export type User = z.infer<typeof UserSchema>;
`;

const typedGoodSource = `
import { UserSchema } from "./schemas";

export const documentParser = {
  parse(text: string) {
    return text.trim();
  },
  transform(step: (text: string) => string) {
    return step;
  },
};

export function reparseText(text: string) {
  return documentParser.parse(documentParser.parse(text));
}

export const identityStep = documentParser.transform((text) => text);

export function AmountLabel({ amount }: { amount: string }) {
  return <span>{amount}</span>;
}

export function readUser(raw: unknown) {
  return UserSchema.parse(raw);
}
`;

const typedBadSource = `
import { UserSchema, type User } from "./schemas";

export function decodeTwice(raw: unknown) {
  const user = UserSchema.parse(raw);
  return UserSchema.parse(user);
}

export function decodeTypedAlias(alreadyDecoded: User) {
  return UserSchema.parse(alreadyDecoded);
}

export const IdentityUserSchema = UserSchema.transform((user) => user);

export function AmountCell({ amount }: { amount: number }) {
  return <span>{amount}</span>;
}
`;

const typedBadDiagnostics = [
  {
    ruleId: "antidrift/no-redundant-zod-parse",
    message:
      "Binding 'user' was already decoded by 'UserSchema' in this scope; reuse the decoded value instead of re-parsing.",
  },
  {
    ruleId: "antidrift/no-redundant-zod-parse",
    message:
      "Parameter 'alreadyDecoded' is already typed as a decoded schema output; do not re-parse internal typed values.",
  },
  {
    ruleId: "antidrift/no-identity-schema-transform",
    message:
      "Schema `.transform()` performs an identity pass-through; remove the no-op transform.",
  },
  {
    ruleId: "antidrift/no-unformatted-number",
    message:
      "Format displayed numbers with Intl.NumberFormat(locale).format(value) so the selected locale controls digits and grouping.",
  },
];

function assertReported(messages, expected, hostLabel) {
  for (const { ruleId, message } of expected) {
    assert.ok(
      messages.some(
        (diagnostic) =>
          diagnostic.ruleId === ruleId && diagnostic.message === message
      ),
      `Expected ${hostLabel} ${ruleId}: ${message}; got ${JSON.stringify(messages)}`
    );
  }
}

function writeTypedProject(workDir, repoRoot) {
  writeFileSync(
    join(workDir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        jsx: "preserve",
        skipLibCheck: true,
        noEmit: true,
      },
      include: ["*.ts", "*.tsx"],
    }),
    "utf8"
  );
  mkdirSync(join(workDir, "node_modules"));
  symlinkSync(
    resolve(repoRoot, "node_modules/zod"),
    join(workDir, "node_modules/zod"),
    "dir"
  );
  const typedGoodFile = join(workDir, "typed-good.tsx");
  const typedBadFile = join(workDir, "typed-bad.tsx");
  writeFileSync(join(workDir, "schemas.ts"), schemasSource, "utf8");
  writeFileSync(typedGoodFile, typedGoodSource, "utf8");
  writeFileSync(typedBadFile, typedBadSource, "utf8");
  return { typedGoodFile, typedBadFile };
}

function createTypedEslint(workDir) {
  return new ESLint({
    cwd: workDir,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ["**/*.{ts,tsx}"],
        languageOptions: {
          parser: tsParser,
          parserOptions: {
            ecmaFeatures: { jsx: true },
            projectService: true,
            tsconfigRootDir: workDir,
          },
        },
      },
      createEslintConfig({ files: ["**/*.{ts,tsx}"] }),
    ],
  });
}

function assertParityRules(parityGood, parityBad, expectedRules) {
  assert.equal(
    parityGood.messages.length,
    0,
    `Expected 0 typed ESLint diagnostics on good.tsx, got: ${JSON.stringify(parityGood.messages)}`
  );
  const parityRuleIds = new Set(
    parityBad.messages.map((message) => message.ruleId)
  );
  for (const expected of expectedRules) {
    assert.ok(
      parityRuleIds.has(expected),
      `Expected typed ESLint to report ${expected}, got: ${[...parityRuleIds].join(", ")}`
    );
  }
}

export async function runTypedEslintSmoke({
  workDir,
  repoRoot,
  goodFile,
  badFile,
  expectedRules,
  expectedDiagnostics,
}) {
  const { typedGoodFile, typedBadFile } = writeTypedProject(workDir, repoRoot);
  const eslint = createTypedEslint(workDir);
  const [typedGood, typedBad, parityGood, parityBad] = await eslint.lintFiles([
    typedGoodFile,
    typedBadFile,
    goodFile,
    badFile,
  ]);
  assert.equal(
    typedGood.messages.length,
    0,
    `Expected 0 typed ESLint diagnostics on typed-good.tsx, got: ${JSON.stringify(typedGood.messages)}`
  );
  assertReported(typedBad.messages, typedBadDiagnostics, "typed ESLint");
  assertParityRules(parityGood, parityBad, expectedRules);
  assertReported(parityBad.messages, expectedDiagnostics, "typed ESLint");
}
