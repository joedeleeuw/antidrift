import { isAbsolute, relative, resolve, sep } from "node:path";

import { defineConfig } from "oxlint";

import { loadRegistriesSync } from "../policy/lib/registries.mjs";

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

const applicationExclusionFiles = [
  "**/examples/**",
  "**/example/**",
  "**/__tests__/**",
  "**/*.{test,spec}.{js,jsx,ts,tsx,mts,cts,mjs,cjs}",
];

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
  ];
}

const governanceIgnorePatterns = [
  "**/node_modules/**",
  "**/dist/**",
  "**/coverage/**",
  "reports/**",
];

const declarationIgnorePatterns = [
  "**/*.d.ts",
  "**/*.d.mts",
  "**/*.d.cts",
  "**/*.tsbuildinfo",
];

function governanceRules(restrictedImportPatterns) {
  if (restrictedImportPatterns.length === 0) {
    return {};
  }
  return {
    "no-restricted-imports": restrictedImportsRule(restrictedImportPatterns),
  };
}

export function createGovernanceOxlintConfig({
  repoRoot = process.cwd(),
  policyDir = "policy",
} = {}) {
  const registries = loadRegistriesSync(resolve(repoRoot, policyDir));
  const generatedPatterns = generatedImportPatterns(registries);
  const reactNativePolicy = reactNativePolicyFor(registries.reactNative);
  const otherPatterns = [
    ...generatedPatterns,
    ...gatewayImportPatterns(registries),
  ];

  return defineConfig({
    ignorePatterns: [
      ...governanceIgnorePatterns,
      ...generatedIgnorePatterns(registries, repoRoot),
      ...declarationIgnorePatterns,
    ],
    rules: governanceRules([
      ...otherPatterns,
      ...touchableImportPatterns(reactNativePolicy),
    ]),
    overrides: [
      ...gatewayWrapperOverrides(registries, generatedPatterns),
      ...touchableOwnerOverrides(reactNativePolicy, otherPatterns),
      ...applicationExclusionOverrides(otherPatterns),
    ],
  });
}

export default createGovernanceOxlintConfig;
