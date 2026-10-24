import { fileURLToPath } from "node:url";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { defineConfig } from "oxlint";

import { loadRegistriesSync } from "../policy/lib/registries.mjs";
import { templateSentinelSelectors } from "../policy/lib/property-default-fallbacks.mjs";

const javascriptPlugins = [
  {
    name: "antidrift",
    specifier: fileURLToPath(
      new URL("../oxlint-plugin/index.js", import.meta.url)
    ),
  },
  {
    name: "governance-eslint",
    specifier: fileURLToPath(new URL("./eslint-builtins.mjs", import.meta.url)),
  },
];

const touchableImports = new Map([
  [
    "react-native",
    new Set([
      "Button",
      "Pressable",
      "TouchableHighlight",
      "TouchableNativeFeedback",
      "TouchableOpacity",
      "TouchableWithoutFeedback",
    ]),
  ],
  [
    "react-native-gesture-handler",
    new Set([
      "BaseButton",
      "BorderlessButton",
      "LegacyBaseButton",
      "LegacyBorderlessButton",
      "LegacyPressable",
      "LegacyRawButton",
      "LegacyRectButton",
      "Pressable",
      "RawButton",
      "RectButton",
      "Touchable",
      "TouchableHighlight",
      "TouchableNativeFeedback",
      "TouchableOpacity",
      "TouchableWithoutFeedback",
    ]),
  ],
]);

const hostPathSelectors = [
  {
    selector: "Literal[value=/^\\/(?:Users|home)\\/(?!linuxbrew\\/)[^/]+\\//]",
    message:
      "Host-absolute path literal. Resolve the path from the home directory, the repository root, or configuration.",
  },
  {
    selector:
      "TemplateLiteral[expressions.length=0] > TemplateElement[value.cooked=/^\\/(?:Users|home)\\/(?!linuxbrew\\/)[^/]+\\//]",
    message:
      "Host-absolute path literal. Resolve the path from the home directory, the repository root, or configuration.",
  },
];

const applicationExclusionFiles = [
  "**/examples/**",
  "**/example/**",
  "**/__tests__/**",
  "**/*.{test,spec}.{js,jsx,ts,tsx,mts,cts,mjs,cjs}",
];

const hostPathExclusionFiles = [
  ...applicationExclusionFiles,
  "**/*.stories.{js,jsx,ts,tsx,mts,cts,mjs,cjs}",
  "**/__mocks__/**",
  "**/e2e/**",
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
  "antidrift/no-generic-module-names": "off",
  "antidrift/no-default-export-in-domain": "error",
  "antidrift/no-trivial-property-helpers": "error",
  "antidrift/no-tutorial-comments": "error",
  "antidrift/no-debug-residue-filenames": "error",
  "antidrift/no-placeholder-tests": "error",
  "antidrift/no-unlisted-external-imports": "error",
  "antidrift/no-dated-comments": "error",
  "antidrift/no-fallback-to-empty": [
    "error",
    { excludeFiles: ["**/fixtures/**"] },
  ],
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

function normalizedOwnerPath(ownerPath) {
  if (typeof ownerPath !== "string") {
    throw new TypeError(
      "policy/registries/react-native.yaml allowedFiles entries must be exact repository-relative owner paths."
    );
  }
  const normalized = ownerPath.replaceAll("\\", "/").replace(/^\.\//u, "");
  if (
    !normalized.includes("/") ||
    normalized.startsWith("../") ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//u.test(normalized) ||
    /[!*?{}()[\]]/u.test(normalized)
  ) {
    throw new TypeError(
      "policy/registries/react-native.yaml allowedFiles entries must be exact repository-relative owner paths containing at least one directory and no glob, parent, or absolute-path syntax."
    );
  }
  return normalized;
}

function reactNativePolicyFor(policy) {
  if (!policy || Object.keys(policy).length === 0) return null;
  if (
    typeof policy.replacementImport !== "string" ||
    policy.replacementImport.trim().length === 0
  ) {
    throw new TypeError(
      "policy/registries/react-native.yaml replacementImport must name the app-owned interaction module."
    );
  }
  if (!Array.isArray(policy.allowedFiles) || policy.allowedFiles.length === 0) {
    throw new TypeError(
      "policy/registries/react-native.yaml allowedFiles must name at least one exact owner file."
    );
  }
  return {
    replacementImport: policy.replacementImport,
    allowedFiles: policy.allowedFiles.map(
      (file) => `**/${normalizedOwnerPath(file)}`
    ),
  };
}

function touchableImportPatterns(reactNativePolicy) {
  if (!reactNativePolicy) return [];
  return [...touchableImports].map(([source, names]) => ({
    group: [source],
    importNames: ["default", ...names],
    allowTypeImports: true,
    message: `Raw interaction primitive access from "${source}" bypasses the app-owned interaction policy. Import the shared Touchable from ${reactNativePolicy.replacementImport} and choose a named feedback preset.`,
  }));
}

function touchableOwnerOverrides(reactNativePolicy, otherPatterns) {
  return (reactNativePolicy?.allowedFiles ?? []).map((file) => ({
    files: [file],
    rules: {
      "no-restricted-imports":
        otherPatterns.length > 0 ? restrictedImportsRule(otherPatterns) : "off",
    },
  }));
}

function applicationExclusionOverrides(otherPatterns) {
  return [
    {
      files: applicationExclusionFiles,
      rules: {
        "no-restricted-imports":
          otherPatterns.length > 0
            ? restrictedImportsRule(otherPatterns)
            : "off",
      },
    },
    {
      files: hostPathExclusionFiles,
      rules: { "governance-eslint/no-restricted-syntax": "off" },
    },
  ];
}

const disabledCategories = {
  correctness: "off",
  nursery: "off",
  pedantic: "off",
  perf: "off",
  restriction: "off",
  style: "off",
  suspicious: "off",
};

const governanceIgnorePatterns = [
  "**/node_modules/**",
  "**/dist/**",
  "**/coverage/**",
  "reports/**",
  "tooling/antidrift/src/oxlint-plugin/anti-slop/**",
];

const declarationIgnorePatterns = [
  "**/*.d.ts",
  "**/*.d.mts",
  "**/*.d.cts",
  "**/*.tsbuildinfo",
];

const governanceOptions = {
  denyWarnings: true,
  reportUnusedDisableDirectives: "error",
};

function propertyDefaultOverride(file) {
  if (typeof file !== "string" || file.length === 0) {
    throw new TypeError(
      "propertyDefaultAllowedFiles entries must be non-empty repository-relative file patterns."
    );
  }
  const pattern = file.replaceAll("\\", "/").replace(/^\.\//u, "");
  const invalid = [
    pattern.startsWith("/"),
    /^[A-Za-z]:\//u.test(pattern),
    pattern.split("/").includes(".."),
  ].some(Boolean);
  if (invalid) {
    throw new TypeError(
      `propertyDefaultAllowedFiles entries must stay relative to the repository; received ${file}.`
    );
  }
  return {
    files: [pattern.startsWith("**/") ? pattern : `**/${pattern}`],
    rules: {
      "governance-eslint/no-restricted-syntax": ["error", ...hostPathSelectors],
    },
  };
}

export function createGovernanceOxlintConfig({
  repoRoot = process.cwd(),
  policyDir = "policy",
  enforceNoPropertyDefaultFallbacks = false,
  propertyDefaultAllowedFiles = [],
} = {}) {
  const registries = loadRegistriesSync(resolve(repoRoot, policyDir));
  const statuses = registries.domain?.statuses ?? {};
  const authzFunctions =
    registries.boundaries?.requiredCalls?.authorization ?? [];
  const generatedIgnores = generatedIgnorePatterns(registries, repoRoot);
  const generatedPatterns = generatedImportPatterns(registries);
  const reactNativePolicy = reactNativePolicyFor(registries.reactNative);
  const otherPatterns = [
    ...generatedPatterns,
    ...gatewayImportPatterns(registries),
  ];
  const restrictedImportPatterns = [
    ...otherPatterns,
    ...touchableImportPatterns(reactNativePolicy),
  ];
  const rules = {
    "antidrift/require-effect-deps": "error",
    "antidrift/no-static-property-loop": "error",
    "antidrift/no-unknown-type-aliases": "error",
    "antidrift/no-unsafe-cast-chain": "error",
    "governance-eslint/no-restricted-syntax": [
      "error",
      ...hostPathSelectors,
      ...(enforceNoPropertyDefaultFallbacks ? templateSentinelSelectors : []),
    ],
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
    categories: disabledCategories,
    ignorePatterns: [
      ...governanceIgnorePatterns,
      ...generatedIgnores,
      ...declarationIgnorePatterns,
    ],
    jsPlugins: javascriptPlugins,
    options: governanceOptions,
    plugins: ["eslint", "typescript"],
    rules,
    overrides: [
      ...gatewayWrapperOverrides(registries, generatedPatterns),
      ...touchableOwnerOverrides(reactNativePolicy, otherPatterns),
      ...applicationExclusionOverrides(otherPatterns),
      ...propertyDefaultAllowedFiles.map(propertyDefaultOverride),
    ],
  });
}

export default createGovernanceOxlintConfig;
