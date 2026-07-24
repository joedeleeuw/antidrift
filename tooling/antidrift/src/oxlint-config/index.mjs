import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { defineConfig } from "oxlint";

import { loadRegistriesSync } from "../policy/lib/registries.mjs";

const packageRequire = createRequire(import.meta.url);

const javascriptPlugins = [
  {
    name: "antidrift",
    specifier: fileURLToPath(
      new URL("../oxlint-plugin/index.js", import.meta.url),
    ),
  },
  {
    name: "eslint-comments",
    specifier: packageRequire.resolve(
      "@eslint-community/eslint-plugin-eslint-comments",
    ),
  },
];

const disabledAntidriftRules = {
  "antidrift/no-async-array-method": "off",
  "antidrift/no-calling-components-as-functions": "off",
  "antidrift/no-duplicated-conditional-classnames": "off",
  "antidrift/no-duplicated-object-field-blocks": "off",
  "antidrift/no-handrolled-resource-lifecycle-cells": "off",
  "antidrift/no-inline-structural-type-at-use-site": "off",
  "antidrift/no-nonindependent-test-oracle": "off",
  "antidrift/no-query-data-type-parameters": "off",
  "antidrift/no-raw-fetch-in-component": "off",
  "antidrift/no-shattered-ingested-entity-state": "off",
  "antidrift/no-silent-empty-detection-fallback": "off",
  "antidrift/no-status-literal-in-type": "off",
  "antidrift/require-authz-check": "off",
};

const modifiedComplexityOptions = Object.freeze({
  max: 25,
  variant: "modified",
});
const maxParametersOptions = Object.freeze({ max: 7 });

export const antidriftComplexityRules = Object.freeze({
  complexity: Object.freeze(["error", modifiedComplexityOptions]),
  "max-depth": Object.freeze(["error", 4]),
  "max-params": Object.freeze(["error", maxParametersOptions]),
});

function generatedImportPatterns(registries) {
  return Object.values(registries.generated?.generatedSources ?? {}).flatMap(
    ({
      bannedDirectImports = [],
      message = "Import from the approved generated-type wrapper.",
    }) => bannedDirectImports.map((group) => ({ group: [group], message })),
  );
}

function generatedRegistryPath(repoRoot, name, generated) {
  const label = `policy/registries/generated.yaml generatedSources.${name}.generated`;
  if (typeof generated !== "string" || generated.length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  const normalized = generated.replaceAll("\\", "/");
  if (/[!*?{}()[\]]/u.test(normalized)) {
    throw new TypeError(
      `${label} must be an exact repo path without glob metacharacters.`,
    );
  }
  if (isAbsolute(normalized) || /^[A-Za-z]:\//u.test(normalized)) {
    throw new TypeError(
      `${label} must be a relative repo path below the repository root.`,
    );
  }
  const root = resolve(repoRoot);
  const target = resolve(root, normalized);
  const repoRelative = relative(root, target);
  if (
    repoRelative.length === 0 ||
    repoRelative === ".." ||
    repoRelative.startsWith(`..${sep}`) ||
    isAbsolute(repoRelative)
  ) {
    throw new TypeError(
      `${label} must be a relative repo path below the repository root.`,
    );
  }
  return repoRelative.split(sep).join("/");
}

function generatedIgnorePatterns(registries, repoRoot) {
  const patterns = new Set();

  for (const [name, entry] of Object.entries(
    registries.generated?.generatedSources ?? {},
  )) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TypeError(
        `policy/registries/generated.yaml generatedSources.${name} must be a mapping.`,
      );
    }
    const pattern = generatedRegistryPath(repoRoot, name, entry.generated);
    patterns.add(pattern);
    patterns.add(`${pattern}/**`);
  }

  return [...patterns];
}

function gatewayImportPatterns(registries) {
  return Object.values(registries.gateways?.approvedGateways ?? {}).flatMap(
    ({ bannedDirectImports = [], wrapper }) =>
      bannedDirectImports.map((group) => ({
        group: [group],
        message: `Import through the approved gateway wrapper (${wrapper}).`,
      })),
  );
}

function restrictedImportsRule(patterns) {
  return ["error", { patterns }];
}

function gatewayWrapperOverrides(registries, generatedPatterns) {
  return Object.values(registries.gateways?.approvedGateways ?? {})
    .filter(({ wrapper }) => typeof wrapper === "string" && wrapper.length > 0)
    .map(({ wrapper }) => ({
      files: [wrapper],
      rules: {
        "no-restricted-imports":
          generatedPatterns.length > 0
            ? restrictedImportsRule(generatedPatterns)
            : "off",
      },
    }));
}

export function createGovernanceOxlintConfig({
  repoRoot = process.cwd(),
  policyDir = "policy",
} = {}) {
  const registries = loadRegistriesSync(resolve(repoRoot, policyDir));
  const generatedIgnores = generatedIgnorePatterns(registries, repoRoot);
  const generatedPatterns = generatedImportPatterns(registries);
  const restrictedImportPatterns = [
    ...generatedPatterns,
    ...gatewayImportPatterns(registries),
  ];

  return defineConfig({
    categories: {
      correctness: "off",
      nursery: "off",
      pedantic: "off",
      perf: "off",
      restriction: "off",
      style: "off",
      suspicious: "off",
    },
    ignorePatterns: [
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      "reports/**",
      ...generatedIgnores,
      "**/*.d.ts",
      "**/*.d.mts",
      "**/*.d.cts",
      "**/*.tsbuildinfo",
    ],
    jsPlugins: javascriptPlugins,
    options: {
      denyWarnings: true,
      reportUnusedDisableDirectives: "error",
    },
    plugins: ["eslint"],
    rules: {
      "eslint-comments/require-description": "error",
      "eslint-comments/disable-enable-pair": "error",
      "eslint-comments/no-duplicate-disable": "error",
      "eslint-comments/no-unlimited-disable": "error",
      "eslint-comments/no-unused-disable": "error",
      "eslint-comments/no-unused-enable": "error",
      "antidrift/require-effect-deps": "error",
      ...disabledAntidriftRules,
      "max-lines": [
        "error",
        {
          max: 1500,
          skipBlankLines: false,
          skipComments: false,
        },
      ],
      ...(restrictedImportPatterns.length > 0
        ? {
            "no-restricted-imports": restrictedImportsRule(
              restrictedImportPatterns,
            ),
          }
        : {}),
    },
    overrides: gatewayWrapperOverrides(registries, generatedPatterns),
  });
}

export default createGovernanceOxlintConfig;
