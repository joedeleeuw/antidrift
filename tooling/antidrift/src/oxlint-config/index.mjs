import { fileURLToPath } from "node:url";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { defineConfig } from "oxlint";

import { loadRegistriesSync } from "../policy/lib/registries.mjs";

const javascriptPlugins = [
  {
    name: "antidrift",
    specifier: fileURLToPath(
      new URL("../oxlint-plugin/index.js", import.meta.url)
    ),
  },
];

const additionalAntidriftRules = {
  "antidrift/no-anemic-errors": "error",
  "antidrift/no-relative-cross-package-imports": "error",
  "antidrift/confine-owner": "error",
  "antidrift/docs-source-policy": "error",
  "antidrift/icon-button-requires-tooltip": "error",
  "antidrift/no-adhoc-loader": "error",
  "antidrift/no-ambient-hotkey-format": "error",
  "antidrift/no-async-context-enter-with": "error",
  "antidrift/no-auth-token-in-web-storage": "error",
  "antidrift/no-awaited-builder-union": "error",
  "antidrift/no-centered-scroll-column": "error",
  "antidrift/no-dialog-trigger-menu-item": "error",
  "antidrift/no-disabled-tooltip-trigger": "error",
  "antidrift/no-eager-singleton": "error",
  "antidrift/no-inline-style-colors": "error",
  "antidrift/no-omitted-prop-respread": "error",
  "antidrift/no-partial-record-satisfies": "error",
  "antidrift/no-path-prefix-containment": "error",
  "antidrift/no-physical-properties": "error",
  "antidrift/no-raw-foreground-opacity": "error",
  "antidrift/no-redacted-log-attribute-key": "error",
  "antidrift/no-spread-input-in-query-key": "error",
  "antidrift/no-static-devtools-import": "error",
  "antidrift/no-unformatted-number": "error",
  "antidrift/no-unsafe-inner-html": "error",
  "antidrift/no-portal-under-interactive-ancestor": "error",
  "antidrift/require-detached-label-shape": "error",
  "antidrift/require-dir-on-rendered-name": "error",
  "antidrift/require-exhaustive-panic": "error",
  "antidrift/require-fetch-timeout": "error",
  "antidrift/require-function-replacer": "error",
  "antidrift/require-query-key-factory": "error",
  "antidrift/require-query-signal": "error",
  "antidrift/require-safe-window-open": "error",
  "antidrift/require-stable-snapshot": "error",
  "antidrift/require-stream-reader-disposal": "error",
  "antidrift/no-raw-filename-write": "error",
  "antidrift/no-unsanitized-href": "error",
  "antidrift/require-secure-document-response": "error",
  "antidrift/no-bun-api-in-shared": "error",
  "antidrift/no-duplicate-context": "error",
  "antidrift/no-ai-debt-comments": "error",
  "antidrift/no-as-never": "error",
  "antidrift/no-todo-without-issue": "error",
  "antidrift/no-generic-module-names": "error",
  "antidrift/no-default-export-in-domain": "error",
  "antidrift/no-trivial-property-helpers": "error",
  "antidrift/no-tutorial-comments": "error",
  "antidrift/no-debug-residue-filenames": "error",
  "antidrift/no-placeholder-tests": "error",
  "antidrift/no-unlisted-external-imports": "error",
  "antidrift/no-dated-comments": "error",
  "antidrift/no-else-if-chain": "error",
  "antidrift/no-fallback-to-empty": [
    "error",
    { excludeFiles: ["**/fixtures/**"] },
  ],
  "antidrift/no-hash-literal": "error",
  "antidrift/no-host-path-literal": "error",
  "antidrift/no-async-array-method": "error",
  "antidrift/no-handrolled-resource-lifecycle-cells": "error",
  "antidrift/no-repo-state-mirror-assertion": "error",
  "antidrift/no-status-literal-in-type": "error",
  "antidrift/require-authz-check": "error",
};

function generatedImportPatterns(registries) {
  return Object.values(registries.generated?.generatedSources ?? {}).flatMap(
    ({
      bannedDirectImports = [],
      message = "Import from the approved generated-type wrapper.",
    }) => bannedDirectImports.map((group) => ({ group: [group], message }))
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
      `${label} must be an exact repo path without glob metacharacters.`
    );
  }
  if (isAbsolute(normalized) || /^[A-Za-z]:\//u.test(normalized)) {
    throw new TypeError(
      `${label} must be a relative repo path below the repository root.`
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
      `${label} must be a relative repo path below the repository root.`
    );
  }
  return repoRelative.split(sep).join("/");
}

function generatedIgnorePatterns(registries, repoRoot) {
  const patterns = new Set();

  for (const [name, entry] of Object.entries(
    registries.generated?.generatedSources ?? {}
  )) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TypeError(
        `policy/registries/generated.yaml generatedSources.${name} must be a mapping.`
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
      }))
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
  const statuses = registries.domain?.statuses ?? {};
  const authzFunctions =
    registries.boundaries?.requiredCalls?.authorization ?? [];
  const generatedIgnores = generatedIgnorePatterns(registries, repoRoot);
  const generatedPatterns = generatedImportPatterns(registries);
  const restrictedImportPatterns = [
    ...generatedPatterns,
    ...gatewayImportPatterns(registries),
  ];
  const rules = {
    "antidrift/require-effect-deps": "error",
    "antidrift/no-static-property-loop": "error",
    "antidrift/no-unknown-type-aliases": "error",
    "antidrift/no-unsafe-cast-chain": "error",
    ...additionalAntidriftRules,
    "antidrift/no-status-literal-in-type": ["error", { statuses }],
    "antidrift/require-authz-check": ["error", { authzFunctions }],
  };
  if (restrictedImportPatterns.length > 0) {
    rules["no-restricted-imports"] = restrictedImportsRule(
      restrictedImportPatterns
    );
  }

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
      "tooling/antidrift/src/oxlint-plugin/anti-slop/**",
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
    plugins: ["eslint", "typescript"],
    rules,
    overrides: gatewayWrapperOverrides(registries, generatedPatterns),
  });
}

export default createGovernanceOxlintConfig;
