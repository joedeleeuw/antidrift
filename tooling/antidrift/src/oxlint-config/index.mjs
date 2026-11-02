import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "oxlint";

import { loadRegistriesSync } from "../policy/lib/registries.mjs";
import { loadNativeAddon } from "../policy/oxlint.mjs";

const ANTIDRIFT_PLUGIN = fileURLToPath(
  new URL("../oxlint-plugin/index.mjs", import.meta.url)
);
const BOUNDARIES_PLUGIN = createRequire(import.meta.url).resolve(
  "eslint-plugin-boundaries"
);

function antidriftRuleLevels(repoRoot) {
  return Object.fromEntries(
    loadNativeAddon(repoRoot)
      .antidriftRules()
      .filter(({ defaultEnabled }) => defaultEnabled)
      .flatMap(({ name, lineCap }) =>
        lineCap
          ? [
              [name, "error"],
              [`${name}-near`, "warn"],
            ]
          : [[name, "error"]]
      )
  );
}

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

function generatedRegistryPath(name, generated) {
  const label = `policy/registries/generated.yaml generatedSources.${name}.generated`;
  if (typeof generated !== "string" || generated.length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  const normalized = generated
    .replaceAll("\\", "/")
    .replace(/^\.\//u, "")
    .replace(/\/+$/u, "");
  if (/[!*?{}()[\]]/u.test(normalized)) {
    throw new TypeError(
      `${label} must be an exact repo path without glob metacharacters.`
    );
  }
  if (
    normalized.length === 0 ||
    isAbsolute(normalized) ||
    /^[A-Za-z]:\//u.test(normalized) ||
    normalized
      .split("/")
      .some((seg) => seg.length === 0 || seg === "." || seg === "..")
  ) {
    throw new TypeError(
      `${label} must be a relative repo path below the repository root.`
    );
  }
  return normalized;
}

function generatedIgnorePatterns(registries) {
  const patterns = new Set();

  for (const [name, entry] of Object.entries(
    registries.generated?.generatedSources ?? {}
  )) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TypeError(
        `policy/registries/generated.yaml generatedSources.${name} must be a mapping.`
      );
    }
    const pattern = generatedRegistryPath(name, entry.generated);
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

function restrictedImportsRulesMap(patterns) {
  return Object.fromEntries([
    [
      "no-restricted-imports",
      patterns.length > 0 ? restrictedImportsRule(patterns) : "off",
    ],
  ]);
}

function gatewayWrapperOverrides(registries, generatedPatterns) {
  return Object.values(registries.gateways?.approvedGateways ?? {})
    .filter(({ wrapper }) => typeof wrapper === "string" && wrapper.length > 0)
    .map(({ wrapper }) => ({
      files: [wrapper],
      rules: restrictedImportsRulesMap(generatedPatterns),
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
    rules: restrictedImportsRulesMap(otherPatterns),
  }));
}

function applicationExclusionOverrides(otherPatterns) {
  return [
    {
      files: applicationExclusionFiles,
      rules: restrictedImportsRulesMap(otherPatterns),
    },
  ];
}

function domainLayerFiles(registries) {
  return Object.values(registries.architecture?.layers ?? {})
    .filter((layer) => layer?.role === "domain")
    .flatMap((layer) => layer.roots ?? [])
    .filter((root) => typeof root === "string" && root.length > 0)
    .map((root) =>
      root.endsWith("/**")
        ? `${root.slice(0, -3)}/**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}`
        : root
    );
}

const domainDefaultExportExclusions = [
  "**/__tests__/**",
  "**/*.{test,spec}.{js,jsx,ts,tsx,mjs,cjs,mts,cts}",
  "**/*.{gen,generated,d}.{js,jsx,ts,tsx,mjs,cjs,mts,cts}",
  "**/migration/**",
  "**/migrations/**",
  ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap((digit) => [
    `**/${digit}*_*`,
    `**/${digit}*-*`,
  ]),
];

function domainDefaultExportOverrides(registries) {
  const files = domainLayerFiles(registries);
  if (files.length === 0) {
    return [];
  }
  return [
    {
      files,
      plugins: ["import"],
      rules: {
        "import/no-default-export": "error",
      },
    },
    {
      files: domainDefaultExportExclusions,
      plugins: ["import"],
      rules: {
        "import/no-default-export": "off",
      },
    },
  ];
}

const governanceIgnorePatterns = [
  "**/node_modules/**",
  "**/coverage/**",
  "reports/**",
];

const declarationIgnorePatterns = [
  "**/*.d.ts",
  "**/*.d.mts",
  "**/*.d.cts",
  "**/*.tsbuildinfo",
];

function architectureLayers(registries) {
  return Object.entries(registries.architecture?.layers ?? {}).filter(
    ([, layer]) =>
      layer &&
      typeof layer === "object" &&
      !Array.isArray(layer) &&
      Array.isArray(layer.roots) &&
      layer.roots.length > 0
  );
}

function architectureBoundarySettings(layers) {
  if (layers.length === 0) {
    return undefined;
  }
  return {
    "boundaries/elements": layers.flatMap(([type, layer]) =>
      layer.roots.map((pattern) => ({ type, pattern }))
    ),
  };
}

function governanceRules(restrictedImportPatterns, layers) {
  const entries = [];
  if (restrictedImportPatterns.length > 0) {
    entries.push([
      "no-restricted-imports",
      restrictedImportsRule(restrictedImportPatterns),
    ]);
  }
  if (layers.length > 0) {
    entries.push([
      "boundaries/element-types",
      [
        "error",
        {
          default: "disallow",
          rules: layers.map(([from, layer]) => ({
            from,
            allow: Array.isArray(layer.mayImport) ? layer.mayImport : [],
          })),
        },
      ],
    ]);
  }
  return Object.fromEntries(entries);
}

function governancePlugins(layers) {
  return [
    ANTIDRIFT_PLUGIN,
    ...(layers.length > 0
      ? [{ name: "boundaries", specifier: BOUNDARIES_PLUGIN }]
      : []),
  ];
}

export function createGovernanceOxlintConfig({
  repoRoot = process.cwd(),
  policyDir = "policy",
} = {}) {
  const registries = loadRegistriesSync(resolve(repoRoot, policyDir));
  const layers = architectureLayers(registries);
  const generatedPatterns = generatedImportPatterns(registries);
  const reactNativePolicy = reactNativePolicyFor(registries.reactNative);
  const otherPatterns = [
    ...generatedPatterns,
    ...gatewayImportPatterns(registries),
  ];
  const settings = architectureBoundarySettings(layers);
  const allPatterns = [
    ...otherPatterns,
    ...touchableImportPatterns(reactNativePolicy),
  ];
  return defineConfig({
    jsPlugins: governancePlugins(layers),
    ...(settings ? { settings } : {}),
    ignorePatterns: [
      ...governanceIgnorePatterns,
      ...generatedIgnorePatterns(registries),
      ...declarationIgnorePatterns,
    ],
    rules: {
      ...antidriftRuleLevels(repoRoot),
      ...governanceRules(allPatterns, layers),
    },
    overrides: [
      ...gatewayWrapperOverrides(registries, generatedPatterns),
      ...touchableOwnerOverrides(reactNativePolicy, otherPatterns),
      ...applicationExclusionOverrides(otherPatterns),
      ...domainDefaultExportOverrides(registries),
    ],
  });
}

export default createGovernanceOxlintConfig;
