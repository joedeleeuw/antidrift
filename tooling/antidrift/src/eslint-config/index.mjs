import { resolve } from "node:path";
import { loadRegistriesSync } from "../policy/lib/registries.mjs";
import js from "@eslint/js";
import boundaries from "eslint-plugin-boundaries";
import jsxA11y from "eslint-plugin-jsx-a11y";
import noOnlyTests from "eslint-plugin-no-only-tests";
import reactHooks from "eslint-plugin-react-hooks";
import sonarjs from "eslint-plugin-sonarjs";
import tseslint from "typescript-eslint";
import globals from "globals";
import aiPolicy from "../eslint-plugin/index.js";

/**
 * Shareable flat config for the AI guardrails policy.
 * @param {{ tsconfigRootDir?: string, policyDir?: string }} [options]
 *   tsconfigRootDir: consumer repo root (import.meta.dirname of its eslint.config.mjs)
 *   policyDir: path to the policy directory, relative to tsconfigRootDir (default: "policy")
 */
export function createConfig({ tsconfigRootDir, policyDir = "policy" } = {}) {
  const absPolicyDir = tsconfigRootDir ? resolve(tsconfigRootDir, policyDir) : resolve(policyDir);
  const registries = loadRegistriesSync(absPolicyDir);
  return tseslint.config(
    {
      ignores: [
        "**/node_modules/**",
        "**/dist/**",
        "**/coverage/**",
        "reports/**",
        "docs/examples/**",
        "**/fixtures/**",
        "**/*.tsbuildinfo"
      ],
    },
    js.configs.recommended,
    ...tseslint.configs.recommendedTypeChecked,
    sonarjs.configs.recommended,
    {
      files: ["**/*.{ts,tsx,js,mjs,cjs}"],
      languageOptions: {
        parserOptions: {
          projectService: {
            allowDefaultProject: [
              "*.mjs",
              "*.ts",
              "apps/*/vite.config.ts",
            ],
            defaultProject: "./tsconfig.base.json",
          },
          tsconfigRootDir,
        },
        globals: {
          ...globals.browser,
          ...globals.node,
        },
      },
      plugins: {
        boundaries,
        "jsx-a11y": jsxA11y,
        "no-only-tests": noOnlyTests,
        "react-hooks": reactHooks,
        "antidrift": aiPolicy,
      },
      settings: {
        "boundaries/elements": [
          { type: "app", pattern: "apps/*/src/**" },
          { type: "ui", pattern: "packages/ui/src/**" },
          { type: "domain", pattern: "packages/domain/src/**" },
          { type: "contracts", pattern: "packages/contracts/src/**" },
          { type: "api", pattern: "packages/api/src/**" },
          { type: "gateways", pattern: "packages/gateways/src/**" },
          { type: "tooling", pattern: "tooling/**" }
        ],
      },
      rules: {
        // Baseline TypeScript safety: agents should fix contracts, not escape them.
        "@typescript-eslint/no-explicit-any": "error",
        "@typescript-eslint/no-empty-object-type": "error",
        "@typescript-eslint/no-non-null-assertion": "error",
        "@typescript-eslint/no-unsafe-assignment": "error",
        "@typescript-eslint/no-unsafe-member-access": "error",
        "@typescript-eslint/no-unsafe-return": "error",
        "@typescript-eslint/ban-ts-comment": ["error", { "ts-expect-error": "allow-with-description" }],
        "@typescript-eslint/no-unused-vars": ["error", {
          "argsIgnorePattern": "^_",
          "varsIgnorePattern": "^_",
          "caughtErrorsIgnorePattern": "^_"
        }],

        // React hook lifecycle rules are deterministic feedback for generated UI.
        "react-hooks/rules-of-hooks": "error",
        "react-hooks/exhaustive-deps": "error",

        // Focused tests are failed output.
        "no-only-tests/no-only-tests": "error",

        // Architecture boundaries prevent semantic drift across layers.
        "boundaries/element-types": ["error", {
          default: "disallow",
          rules: [
            { from: "app", allow: ["ui", "domain", "contracts"] },
            { from: "ui", allow: ["domain"] },
            { from: "domain", allow: [] },
            { from: "contracts", allow: ["domain"] },
            { from: "api", allow: ["domain", "contracts", "gateways"] },
            { from: "gateways", allow: ["domain", "contracts"] },
            { from: "tooling", allow: ["tooling"] }
          ]
        }],
        "boundaries/no-private": "error",

        // AI-specific custom rules from the local plugin.
        "antidrift/no-trivial-selector-wrapper": "error",
        "antidrift/no-explicit-return-type-private-helper": "error",
        "antidrift/no-inline-structural-type-at-use-site": "error",
        "antidrift/no-unsafe-cast-chain": "error",
        "antidrift/no-silent-catch": "error",
        "antidrift/no-inline-disable-without-ticket": "error",
        "antidrift/no-coupled-state-setters": "error",
        "antidrift/no-status-triplet-state": "error",
        "antidrift/require-effect-deps": "error",
        "antidrift/no-raw-tailwind-color": "error",
        "antidrift/no-hover-translate-card": "error",
        "antidrift/no-raw-fetch-in-component": "error",
        "antidrift/no-async-array-method": "error",
        "antidrift/no-obvious-comment": "error",

        // generated-type-drift: structural fork detection against installed package types (type-aware).
        "antidrift/no-structural-type-fork": "error",

        // validation-drift: re-parsing a value with the schema that already produced it (type-aware).
        "antidrift/no-redundant-zod-parse": "error",

        // Data-lifecycle security rules.
        // no-hardcoded-secret: enforced via secretlint pre-commit hook — variable-name heuristics
        // in lint rules produce too many false positives. See policy/registries/dependencies.yaml.
        "antidrift/no-sql-string-concat": "error",
        "antidrift/no-unsafe-deserialize": "error",

        // Registry-driven rules: options are loaded from policy registries at config-construction time.
        "antidrift/no-sdk-direct-use": ["error", { gateways: registries.gateways?.approvedGateways ?? {} }],
        "antidrift/no-status-literal-in-type": ["error", { statuses: registries.domain?.statuses ?? {} }],
        "antidrift/no-role-literal-in-type": ["error", { roles: registries.domain?.roles ?? {} }],

        "no-await-in-loop": "error"
      },
    },
    {
      // require-authz-check: scoped to server boundaries declared in the boundaries registry.
      files: ["packages/*/src/routes/**/*.{ts,tsx}", "packages/*/src/actions/**/*.{ts,tsx}"],
      rules: {
        "antidrift/require-authz-check": ["error", {
          authzFunctions: [
            ...(registries.boundaries?.requiredCalls?.authentication ?? []),
            ...(registries.boundaries?.requiredCalls?.authorization ?? []),
            ...(registries.boundaries?.requiredCalls?.tenancy ?? []),
          ],
        }],
      },
    },
    // generated-type-drift: gen/require-import-from-generated — no-restricted-imports driven by generated registry.
    // Block is omitted when the registry has no declared sources (safe default for template).
    ...(() => {
      const sources = Object.values(registries.generated?.generatedSources ?? {});
      const patterns = sources.flatMap(({ bannedDirectImports = [], message = "Import from the approved generated-type wrapper." }) =>
        bannedDirectImports.map((group) => ({ group: [group], message }))
      );
      return patterns.length > 0
        ? [{ rules: { "no-restricted-imports": ["error", { patterns }] } }]
        : [];
    })(),
    {
      files: ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts", "**/*.spec.tsx"],
      rules: {
        "@typescript-eslint/no-non-null-assertion": "off",
        "antidrift/no-explicit-return-type-private-helper": "off",
        "antidrift/no-inline-structural-type-at-use-site": "off"
      },
    },
    {
      files: ["tooling/**"],
      rules: {
        "no-console": "off",
        "@typescript-eslint/no-unsafe-assignment": "off",
        "@typescript-eslint/no-unsafe-member-access": "off",
        "@typescript-eslint/no-unsafe-return": "off",
        "@typescript-eslint/no-unsafe-call": "off",
        "@typescript-eslint/no-unsafe-argument": "off",
        "@typescript-eslint/restrict-template-expressions": "off",
        "sonarjs/no-os-command-from-path": "off",
      },
    },
    {
      files: ["eslint.config.mjs"],
      rules: {
        "sonarjs/deprecation": "off",
        "@typescript-eslint/no-unsafe-assignment": "off",
      },
    }
  );
}

export default createConfig;
