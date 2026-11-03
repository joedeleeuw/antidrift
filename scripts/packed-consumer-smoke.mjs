import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import tsParser from "@typescript-eslint/parser";
import { ESLint } from "eslint";

function extractTarballToConsumer(tarballPath, workDir) {
  const consumerDir = join(workDir, "packed-consumer");
  const pkgDir = join(consumerDir, "node_modules/@joedeleeuw/antidrift");
  mkdirSync(pkgDir, { recursive: true });
  execFileSync("tar", [
    "-xzf",
    tarballPath,
    "--strip-components=1",
    "-C",
    pkgDir,
  ]);
  writeFileSync(
    join(consumerDir, "package.json"),
    JSON.stringify({
      name: "packed-consumer",
      private: true,
      type: "module",
      dependencies: {
        "@expo/ui": "1.0.0",
        react: "19.0.0",
        zod: "4.0.0",
      },
    }),
    "utf8"
  );
  return { consumerDir, pkgDir };
}

function assertExportTargetsExist(pkgDir, exportsMap) {
  const entries = [];
  for (const [subpath, target] of Object.entries(exportsMap)) {
    if (subpath === "./package.json") continue;
    const relTarget = typeof target === "string" ? target : target?.import;
    const typesTarget = typeof target === "object" ? target?.types : null;
    assert.equal(
      typeof relTarget,
      "string",
      `Export ${subpath} missing import target`
    );
    assert.ok(
      existsSync(resolve(pkgDir, relTarget)),
      `Packed tarball is missing export target ${relTarget} for ${subpath}`
    );
    if (typeof typesTarget === "string") {
      assert.ok(
        existsSync(resolve(pkgDir, typesTarget)),
        `Packed tarball is missing types target ${typesTarget} for ${subpath}`
      );
    }
    entries.push([subpath, relTarget]);
  }
  return entries;
}

async function verifyExportSubpaths(consumerDir, pkgDir, expectedRuleCount) {
  const manifest = JSON.parse(
    readFileSync(join(pkgDir, "package.json"), "utf8")
  );
  assert.deepEqual(
    manifest.dependencies ?? {},
    {},
    "Packed manifest must have zero runtime dependencies"
  );
  const entries = assertExportTargetsExist(pkgDir, manifest.exports ?? {});
  const loadedPairs = await Promise.all(
    entries.map(async ([subpath, relTarget]) => [
      subpath,
      await import(pathToFileURL(resolve(pkgDir, relTarget)).href),
    ])
  );
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      [
        'import root, { rules } from "@joedeleeuw/antidrift";',
        'import oxlintPlugin from "@joedeleeuw/antidrift/oxlint-plugin";',
        'import eslintPlugin from "@joedeleeuw/antidrift/eslint-plugin";',
        'import oxlintConfig from "@joedeleeuw/antidrift/oxlint-config";',
        'import eslintConfig from "@joedeleeuw/antidrift/eslint-config";',
        'import preset from "@joedeleeuw/antidrift/preset";',
        `if (Object.keys(rules).length !== ${expectedRuleCount}) throw new Error("Rule count mismatch");`,
        'if (!root?.rules || !oxlintPlugin?.rules || !eslintPlugin?.rules || !oxlintConfig?.rules || !eslintConfig?.rules || !preset?.rules) throw new Error("Missing rules");',
      ].join("\n"),
    ],
    { cwd: consumerDir, encoding: "utf8" }
  );
  return new Map(loadedPairs);
}

function runOxlintJson(oxlintBin, configPath, targetFile, consumerDir) {
  try {
    return JSON.parse(
      execFileSync(oxlintBin, ["-c", configPath, "--format=json", targetFile], {
        cwd: consumerDir,
        encoding: "utf8",
      })
    );
  } catch (error) {
    return JSON.parse(String(error.stdout ?? "{}"));
  }
}

function verifyConsumerOxlint(options) {
  const {
    consumerDir,
    pkgDir,
    repoRoot,
    createOxlintConfig,
    consumerGood,
    consumerBad,
    expectedRules,
  } = options;
  const consumerOxlintConfig = join(consumerDir, "oxlint.config.json");
  const pluginSpecifier = join(pkgDir, "src/oxlint-plugin/index.js");
  writeFileSync(
    consumerOxlintConfig,
    JSON.stringify(createOxlintConfig({ pluginSpecifier })),
    "utf8"
  );
  const oxlintBin = resolve(repoRoot, "node_modules/.bin/oxlint");
  const goodOxlint = runOxlintJson(
    oxlintBin,
    consumerOxlintConfig,
    consumerGood,
    consumerDir
  );
  assert.equal(goodOxlint.diagnostics.length, 0);
  const badOxlint = runOxlintJson(
    oxlintBin,
    consumerOxlintConfig,
    consumerBad,
    consumerDir
  );
  const badCodes = new Set(
    (badOxlint.diagnostics ?? []).map((diag) => diag.code)
  );
  for (const expected of expectedRules) {
    const slug = expected.split("/")[1];
    assert.ok(
      badCodes.has(expected) || badCodes.has(`antidrift(${slug})`),
      `Packed consumer Oxlint missed ${expected}`
    );
  }
}

async function verifyConsumerEslint({
  consumerDir,
  createEslintConfig,
  consumerGood,
  consumerBad,
  expectedRules,
}) {
  const eslint = new ESLint({
    cwd: consumerDir,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ["**/*.{ts,tsx}"],
        languageOptions: {
          parser: tsParser,
          parserOptions: { ecmaFeatures: { jsx: true } },
        },
      },
      createEslintConfig({ files: ["**/*.{ts,tsx}"] }),
    ],
  });
  const [eslintGood, eslintBad] = await eslint.lintFiles([
    consumerGood,
    consumerBad,
  ]);
  assert.equal(
    eslintGood.messages.length,
    0,
    `Packed consumer ESLint reported on good.tsx: ${JSON.stringify(eslintGood.messages)}`
  );
  const badRuleIds = new Set(
    eslintBad.messages.map((message) => message.ruleId)
  );
  for (const expected of expectedRules) {
    assert.ok(
      badRuleIds.has(expected),
      `Packed consumer ESLint missed ${expected}`
    );
  }
}

export async function runPackedConsumerSmoke(options) {
  const {
    tarballPath,
    workDir,
    repoRoot,
    goodFile,
    badFile,
    expectedRuleCount,
    expectedRules,
  } = options;
  const { consumerDir, pkgDir } = extractTarballToConsumer(
    tarballPath,
    workDir
  );
  const loadedModules = await verifyExportSubpaths(
    consumerDir,
    pkgDir,
    expectedRuleCount
  );
  const { createEslintConfig } = loadedModules.get("./eslint-config");
  const { createOxlintConfig } = loadedModules.get("./oxlint-config");
  const consumerGood = join(consumerDir, "good.tsx");
  const consumerBad = join(consumerDir, "bad.tsx");
  copyFileSync(goodFile, consumerGood);
  copyFileSync(badFile, consumerBad);
  verifyConsumerOxlint({
    consumerDir,
    pkgDir,
    repoRoot,
    createOxlintConfig,
    consumerGood,
    consumerBad,
    expectedRules,
  });
  await verifyConsumerEslint({
    consumerDir,
    createEslintConfig,
    consumerGood,
    consumerBad,
    expectedRules,
  });
}
