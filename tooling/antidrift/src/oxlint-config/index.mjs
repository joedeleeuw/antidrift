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
  "antidrift/no-wrapping-functions": "error",
  "antidrift/no-tutorial-comments": "error",
  "antidrift/no-debug-residue-filenames": "error",
  "antidrift/no-placeholder-tests": "error",
  "antidrift/no-unlisted-external-imports": "error",
  "antidrift/no-async-array-method": "off",
  "antidrift/no-calling-components-as-functions": "off",
  "antidrift/no-convex-return-widening": "off",
  "antidrift/no-conditional-empty-object-spread": "off",
  "antidrift/no-duplicated-conditional-classnames": "off",
  "antidrift/no-duplicated-object-field-blocks": "off",
  "antidrift/no-handrolled-resource-lifecycle-cells": "off",
  "antidrift/no-inline-structural-type-at-use-site": "off",
  "antidrift/no-module-mocking": "off",
  "antidrift/no-mocked-response-body-oracle": "off",
  "antidrift/no-nonindependent-test-oracle": "off",
  "antidrift/no-open-dictionary-at-boundary": "off",
  "antidrift/no-redeclared-owned-union": "off",
  "antidrift/no-repo-state-mirror-assertion": "off",
  "antidrift/no-schema-library-in-test": "off",
  "antidrift/no-object-parameters": "off",
  "antidrift/no-raw-fetch-in-component": "off",
  "antidrift/no-raw-react-native-touchables": "off",
  "antidrift/no-reflect-apply": "off",
  "antidrift/no-reflect-get": "off",
  "antidrift/no-runtime-typeof": "off",
  "antidrift/no-service-constructor-imports": "off",
  "antidrift/no-sentinel-absence-fallback": "off",
  "antidrift/no-shattered-ingested-entity-state": "off",
  "antidrift/no-silent-empty-detection-fallback": "off",
  "antidrift/no-shape-in-symbol-names": "off",
  "antidrift/no-status-literal-in-type": "off",
  "antidrift/no-unknown-parameters": "off",
  "antidrift/unknown-input-must-be-decoded": "off",
  "antidrift/no-unknown-returns": "off",
  "antidrift/no-unsafe-dictionary-type": "off",
  "antidrift/no-validator-output-oracle": "off",
  "antidrift/require-authz-check": "off",
  "antidrift/require-safety-comment-for-type-assertion": "off",
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
