function lines(count, prefix = "Line") {
  return Array.from(
    { length: count },
    (_, index) => `export type ${prefix}${index} = string;`
  ).join("\n");
}

export function scaffoldConsumerWorkspace({ file, tarball, toolingTarball }) {
  file("pnpm-workspace.yaml", "packages:\n  - packages/*\n");
  file(
    "policy/registries/generated.yaml",
    "generatedSources:\n" +
      "  appGenerated:\n" +
      "    generated: packages/app/src/generated\n" +
      "  routeTree:\n" +
      "    generated: src/routeTree.gen.ts\n"
  );
  file("policy/registries/rules.yaml", "schemaVersion: 1\n");
  file(
    "package.json",
    JSON.stringify(
      {
        name: "antidrift-consumer-fixture",
        private: true,
        type: "module",
        devDependencies: {
          "@joedeleeuw/antidrift": `file:${tarball}`,
          "@joedeleeuw/typescript-tooling": `file:${toolingTarball}`,
          "@types/node": "22.19.19",
          oxlint: "1.89.0",
          typescript: "6.0.3",
          vitest: "2.1.9",
          firebase: "workspace:*",
        },
      },
      null,
      2
    ) + "\n"
  );
  const baseCompilerOptions = {
    target: "ES2022",
    module: "ESNext",
    moduleResolution: "Bundler",
    jsx: "preserve",
    strict: true,
    skipLibCheck: true,
    esModuleInterop: true,
    noEmit: true,
  };
  file(
    "tsconfig.base.json",
    JSON.stringify(
      {
        compilerOptions: baseCompilerOptions,
      },
      null,
      2
    ) + "\n"
  );
  file(
    "tsconfig.bundler.json",
    JSON.stringify(
      {
        compilerOptions: {
          ...baseCompilerOptions,
        },
        include: ["packages/app/src/**/*.ts", "portable-proofs/**/*.ts"],
      },
      null,
      2
    ) + "\n"
  );
  file(
    "tsconfig.nodenext.json",
    JSON.stringify(
      {
        compilerOptions: {
          ...baseCompilerOptions,
          module: "NodeNext",
          moduleResolution: "NodeNext",
        },
        include: ["packages/app/src/**/*.ts"],
      },
      null,
      2
    ) + "\n"
  );
  file(
    "oxlint.config.mjs",
    'import { createGovernanceOxlintConfig } from "@joedeleeuw/antidrift/oxlint-config";\n' +
      'import { createConfig } from "@joedeleeuw/typescript-tooling/oxlint";\n' +
      "const governance = createGovernanceOxlintConfig({ repoRoot: import.meta.dirname });\n" +
      "const tooling = createConfig({ repoRoot: import.meta.dirname, typeAware: false });\n" +
      "export default {\n" +
      "  ...tooling, ...governance,\n" +
      "  rules: { ...tooling.rules, ...governance.rules },\n" +
      "  jsPlugins: [...governance.jsPlugins, ...tooling.jsPlugins],\n" +
      "  plugins: [...new Set([...governance.plugins, ...tooling.plugins])],\n" +
      "  options: { ...tooling.options, ...governance.options },\n" +
      "  ignorePatterns: [...new Set([...governance.ignorePatterns, ...tooling.ignorePatterns])],\n" +
      "  overrides: [...(tooling.overrides ?? []), ...governance.overrides],\n" +
      "};\n"
  );
  file(
    "react-native-policy/registries/react-native.yaml",
    'replacementImport: "@/tw"\n' +
      "allowedFiles:\n" +
      "  - portable-proofs/tw/index.tsx\n"
  );
  file(
    "oxlint.react-native.config.mjs",
    'import { createGovernanceOxlintConfig } from "@joedeleeuw/antidrift/oxlint-config";\n' +
      "export default createGovernanceOxlintConfig({ repoRoot: import.meta.dirname, policyDir: 'react-native-policy' });\n"
  );
  file(
    "portable-proofs/raw-touchable.tsx",
    'import ReactNative, { Pressable, View } from "react-native";\n' +
      'import * as GestureHandler from "react-native-gesture-handler";\n' +
      'export { TouchableOpacity } from "react-native";\n' +
      'export { default as NativeDefault } from "react-native";\n' +
      'export * as Native from "react-native";\n' +
      "export const primitives = { ReactNative, Pressable, View, GestureHandler };\n"
  );
  file(
    "portable-proofs/tw/index.tsx",
    'import { Pressable } from "react-native";\nexport const Interaction = Pressable;\n'
  );
  file(
    "portable-proofs/type-only-touchable.tsx",
    'import type { PressableProps, TouchableOpacityProps } from "react-native";\n' +
      "export type Props = PressableProps;\n" +
      'export type { TouchableOpacityProps } from "react-native";\n'
  );
  file(
    "nested/oxlint.fallback.config.mjs",
    'import { resolve } from "node:path";\n' +
      'import { createGovernanceOxlintConfig } from "@joedeleeuw/antidrift/oxlint-config";\n' +
      'import { createConfig } from "@joedeleeuw/typescript-tooling/oxlint";\n' +
      "const repoRoot = resolve(import.meta.dirname, '..');\n" +
      "const governance = createGovernanceOxlintConfig({ repoRoot });\n" +
      "const tooling = createConfig({ repoRoot, typeAware: false, enforceNoPropertyDefaultFallbacks: true, propertyDefaultAllowedFiles: ['portable-proofs/allowed-fallback.ts'] });\n" +
      "export default { ...tooling, ...governance, rules: { ...tooling.rules, ...governance.rules }, jsPlugins: [...governance.jsPlugins, ...tooling.jsPlugins], plugins: [...new Set([...governance.plugins, ...tooling.plugins])], options: { ...tooling.options, ...governance.options }, ignorePatterns: [...new Set([...governance.ignorePatterns, ...tooling.ignorePatterns])], overrides: [...(tooling.overrides ?? []), ...governance.overrides] };\n"
  );
  file(
    "portable-proofs/fallback.ts",
    "export function labels(row: { state?: string; count?: number }) {\n" +
      '  return { state: row?.state ?? "unknown", template: row?.state ?? `unknown`, count: row.count ?? 0 };\n' +
      "}\n" +
      'export const developerPath = "/home/example/project";\n' +
      "export const templatePath = `/Users/example/project`;\n" +
      "export function projectPath(project: string) { return `/home/example/${project}`; }\n"
  );
  file(
    "portable-proofs/allowed-fallback.ts",
    "export function count(row: { count?: number }) { return row.count ?? 0; }\n"
  );
  file(
    "oxlint.precedence.config.mjs",
    'import config from "./oxlint.config.mjs";\n' +
      "export default {\n" +
      "  ...config,\n" +
      "  rules: {\n" +
      "    ...config.rules,\n" +
      '    "max-lines": "off",\n' +
      "  },\n" +
      "};\n"
  );
  file("oversized-root.ts", lines(1_501, "RootLine"));
  file("convex/oversized.ts", lines(1_501, "ConvexLine"));
  file("convex/schema.d.ts", lines(1_501, "SchemaLine"));
  file("scripts/oversized-script.ts", lines(1_501, "ScriptLine"));
  file("src/fixtures/helper.ts", lines(1_501, "HelperLine"));
  file("tests/oversized-test.ts", lines(1_501, "TestLine"));
  file("src/_generated/oversized.ts", lines(1_501, "GenLine"));
  file("src/generated/oversized.ts", lines(1_501, "GenDirLine"));
  file("src/undeclared.gen.ts", lines(1_501, "UndeclaredGenLine"));
  file("src/undeclared.generated.ts", lines(1_501, "UndeclaredGeneratedLine"));
  file("src/routeTree.gen.ts", lines(1_501, "RouteLine"));
  file("packages/app/src/generated/oversized.ts", lines(1_501, "AppGenLine"));
  file(
    "src/fixtures/raw.json",
    JSON.stringify(
      Array.from({ length: 1_501 }, (_, index) => index),
      null,
      2
    )
  );
  file(
    "evidence/raw.json",
    JSON.stringify(
      Array.from({ length: 1_501 }, (_, index) => index),
      null,
      2
    )
  );
  file(
    "packages/firebase/package.json",
    JSON.stringify(
      {
        name: "firebase",
        version: "0.0.0",
        type: "module",
        exports: {
          "./auth": {
            types: "./auth.d.ts",
            default: "./auth.js",
          },
        },
      },
      null,
      2
    ) + "\n"
  );
  file(
    "packages/firebase/auth.d.ts",
    "export type User = {\n" +
      "  uid: string;\n" +
      "  email: string | null;\n" +
      "  displayName: string | null;\n" +
      "  photoURL: string | null;\n" +
      "  providerId: string;\n" +
      "  phoneNumber: string | null;\n" +
      "};\n"
  );
  file("packages/firebase/auth.js", "export {};\n");
  file(
    "packages/app/tsconfig.json",
    JSON.stringify(
      {
        extends: "../../tsconfig.base.json",
        include: ["src/**/*.ts"],
      },
      null,
      2
    ) + "\n"
  );
  file(
    "packages/app/src/clean.ts",
    'import type { User } from "firebase/auth";\n' +
      'export function displayName(u: User): string {\n  return u.displayName ?? "anon";\n}\n'
  );
  file(
    "packages/app/src/generated/release.ts",
    "export type GeneratedRelease = {\n" +
      "  id: string;\n  appId: string;\n  version: string;\n" +
      '  status: "draft" | "submitted" | "released";\n  createdAt: number;\n};\n'
  );
  file(
    "packages/app/src/drift.ts",
    "export type ReleaseRow = {\n" +
      "  id: string;\n  appId: string;\n  version: string;\n" +
      '  status: "draft" | "submitted" | "released";\n  createdAt: number;\n};\n'
  );
  file(
    "packages/app/src/underchecked-predicate.ts",
    "type User = { id: string; email: string };\n" +
      "export function isUser(value: unknown): value is User {\n" +
      '  return typeof value === "object" && value !== null && "id" in value;\n' +
      "}\n"
  );
  file(
    "packages/app/src/merged-projections.ts",
    "type SourceRow = { name?: string; score: number };\n" +
      "type TargetRow = { label?: string };\n" +
      "declare const source: SourceRow;\n" +
      "function getStringValue(row: SourceRow) { return row.name ?? ''; }\n" +
      "export const nameLength = getStringValue(source).length;\n" +
      "function userName(row: SourceRow) { return row.name; }\n" +
      "export const directNameLength = userName(source)?.length;\n" +
      "function projectRow(row: SourceRow): TargetRow { return { label: row.name }; }\n" +
      "export const projected = projectRow(source);\n" +
      "function repackRow(row: SourceRow) { return { label: row.name }; }\n" +
      "export const repacked = repackRow(source);\n"
  );
  file(
    "packages/app/src/package-copy.ts",
    "export type AuthUser = {\n" +
      "  uid: string;\n  email: string | null;\n  displayName: string | null;\n" +
      "  photoURL: string | null;\n  providerId: string;\n  phoneNumber: string | null;\n};\n"
  );
  file(
    "packages/app/src/async-foreach-drift.ts",
    "export function cleanup(items: Array<{ save(): Promise<void> }>) {\n" +
      "  items.forEach(async (item) => {\n" +
      "    await item.save();\n" +
      "  });\n" +
      "}\n"
  );
  file(
    "packages/app/src/brand.ts",
    'import { brand, type Brand, type Unbrand } from "@joedeleeuw/antidrift/brand";\n' +
      'const UserId = brand("UserId", (value): value is string => typeof value === "string" && value.startsWith("user_"));\n' +
      'type UserId = Brand<string, "UserId">;\n' +
      "type RawUserId = Unbrand<UserId>;\n" +
      "declare const raw: unknown;\n" +
      "const branded = UserId.make(raw);\n" +
      'const rawLiteral: RawUserId = "user_123";\n' +
      "branded satisfies UserId;\n" +
      "rawLiteral satisfies string;\n"
  );
  file(
    "packages/app/src/exports.ts",
    'import { createAdoptionOxlintConfig, adoptionPresets, complexityRules, createConfig as toolingOxlint, typescriptSyntaxRules, typescriptTypeAwareRules, typescriptBaselineTier, type AdoptionPresetName } from "@joedeleeuw/typescript-tooling/oxlint";\n' +
      'const selectedPreset: AdoptionPresetName = "eslint"; const adoption = createAdoptionOxlintConfig({ presets: [selectedPreset] }); void adoption; void adoptionPresets;\n' +
      'import { defineConfig } from "oxlint";\n' +
      'import { createGovernanceOxlintConfig, loadPolicy, loadRegistriesSync, renderPolicyArtifacts, type AgentGuardrailsPolicy, type AntidriftGovernanceOxlintConfigOptions, type AntidriftRegistries, type PolicyArtifacts } from "@joedeleeuw/antidrift";\n' +
      'import { brand, type Brand, type BrandKit, type BrandSafeResult, type Unbrand } from "@joedeleeuw/antidrift/brand";\n' +
      'import { createGovernanceOxlintConfig as createGovernanceOxlintConfigFromSubpath, type AntidriftGovernanceOxlintConfigOptions as OxlintSubpathConfigOptions } from "@joedeleeuw/antidrift/oxlint-config";\n' +
      'import { SEMANTIC_FACT_KINDS, SEMANTIC_FACT_KIND_CONTRACT_LIST, SEMANTIC_FACT_SCHEMA_VERSION, checkChanged, checkGenerated, checkRegistries, createJsonlFactSink, createMemoryFactSink, defaultAstGrepBinary, DEFAULT_AST_GREP_CONFIG, generate, loadPolicy as loadPolicyFromPolicy, loadRegistriesSync as loadRegistriesFromPolicy, parseOxlintArgs, parseShellGuardrailsArgs, renderPolicyArtifacts as renderPolicyArtifactsFromPolicy, runOxlint, semanticFact, semanticFactKindContractsForAdapterId, semanticFactKindContractsForConfidence, semanticFactKindContractsForEmission, semanticFactKindContractsForRule, semanticFactToJsonLine, shellGuardrails, verifySession, type AgentGuardrailsPolicy as PolicySubpathPolicy, type OxlintArgs, type SemanticFact, type SemanticFactKind, type SemanticFactKindContractEntry } from "@joedeleeuw/antidrift/policy";\n' +
      "\n" +
      "const policy = { clusters: [] } satisfies AgentGuardrailsPolicy;\n" +
      "const subpathPolicy = policy satisfies PolicySubpathPolicy;\n" +
      "const artifacts = renderPolicyArtifacts(policy);\n" +
      'const semantic = semanticFact({ factKind: "test", ruleId: "antidrift/test", adapterId: "test", confidence: "deterministic-inventory", provenance: ["AST"], payload: {} });\n' +
      "const memorySink = createMemoryFactSink();\n" +
      "const jsonlSink = createJsonlFactSink(() => {});\n" +
      'const oxlintOptions = { repoRoot: ".", policyDir: "policy" } satisfies AntidriftGovernanceOxlintConfigOptions & OxlintSubpathConfigOptions;\n' +
      'const oxlintArgs = parseOxlintArgs([], { cwd: ".", exists: () => false }) satisfies OxlintArgs;\n' +
      'const branded = brand("UserId", (value): value is string => typeof value === "string" && value.startsWith("user_"));\n' +
      "\n" +
      "createGovernanceOxlintConfig(oxlintOptions);\n" +
      "createGovernanceOxlintConfigFromSubpath(oxlintOptions);\n" +
      "complexityRules.complexity[1].max satisfies 25;\n" +
      "complexityRules['max-depth'][1] satisfies 4;\n" +
      "complexityRules['max-params'][1].max satisfies 7;\n" +
      "defineConfig({ rules: { ...complexityRules } });\n" +
      "toolingOxlint({ typeAware: false }); void typescriptSyntaxRules; void typescriptTypeAwareRules; void typescriptBaselineTier;\n" +
      "artifacts satisfies PolicyArtifacts;\n" +
      "loadRegistriesSync satisfies (policyDir?: string) => AntidriftRegistries;\n" +
      "loadPolicy satisfies (policyPath?: string) => Promise<AgentGuardrailsPolicy>;\n" +
      "loadPolicyFromPolicy satisfies (policyPath?: string) => Promise<PolicySubpathPolicy>;\n" +
      "loadRegistriesFromPolicy satisfies (policyDir?: string) => AntidriftRegistries;\n" +
      "renderPolicyArtifactsFromPolicy(subpathPolicy) satisfies PolicyArtifacts;\n" +
      "SEMANTIC_FACT_KINDS.structuralMatch.payloadFields satisfies readonly string[];\n" +
      "SEMANTIC_FACT_KINDS.structuralMatch.association satisfies string;\n" +
      "SEMANTIC_FACT_KINDS.structuralMatch.noSinkBehavior satisfies string;\n" +
      "SEMANTIC_FACT_KIND_CONTRACT_LIST satisfies readonly SemanticFactKindContractEntry[];\n" +
      'semanticFactKindContractsForAdapterId("react-state") satisfies readonly SemanticFactKindContractEntry[];\n' +
      'semanticFactKindContractsForConfidence("deterministic-enforcement") satisfies readonly SemanticFactKindContractEntry[];\n' +
      'semanticFactKindContractsForEmission("blocking-diagnostic") satisfies readonly SemanticFactKindContractEntry[];\n' +
      'semanticFactKindContractsForRule("antidrift/no-handrolled-resource-lifecycle-cells") satisfies readonly SemanticFactKindContractEntry[];\n' +
      '"structuralMatch" satisfies SemanticFactKind;\n' +
      "SEMANTIC_FACT_SCHEMA_VERSION satisfies 1;\n" +
      "semantic satisfies SemanticFact;\n" +
      "semanticFactToJsonLine(semantic) satisfies string;\n" +
      "memorySink.facts satisfies SemanticFact[];\n" +
      "jsonlSink.emit(semantic);\n" +
      "oxlintArgs.targets satisfies string[];\n" +
      "runOxlint satisfies (options?: Record<string, unknown>) => number;\n" +
      'branded satisfies BrandKit<string, "UserId">;\n' +
      'branded.make("user_123") satisfies Brand<string, "UserId">;\n' +
      'branded.safe("user_123") satisfies BrandSafeResult<string, "UserId">;\n' +
      '"user_123" satisfies Unbrand<Brand<string, "UserId">>;\n' +
      "void checkChanged;\n" +
      "void checkGenerated;\n" +
      "void checkRegistries;\n" +
      "void defaultAstGrepBinary;\n" +
      "void DEFAULT_AST_GREP_CONFIG;\n" +
      "void generate;\n" +
      "void parseShellGuardrailsArgs;\n" +
      "void shellGuardrails;\n" +
      "void verifySession;\n"
  );
  file(
    "packages/app/src/runtime.mjs",
    'import * as antidriftPackage from "@joedeleeuw/antidrift";\n' +
      'import { complexityRules, createConfig as toolingOxlint, typescriptSyntaxRules, typescriptTypeAwareRules, typescriptBaselineTier, adoptionPresets, createAdoptionOxlintConfig } from "@joedeleeuw/typescript-tooling/oxlint";\n' +
      'import { createGovernanceOxlintConfig, loadPolicy, loadRegistriesSync, renderPolicyArtifacts } from "@joedeleeuw/antidrift";\n' +
      'import packageMetadata from "@joedeleeuw/antidrift/package.json" with { type: "json" };\n' +
      'import { brand } from "@joedeleeuw/antidrift/brand";\n' +
      'import { createGovernanceOxlintConfig as createGovernanceOxlintConfigFromSubpath } from "@joedeleeuw/antidrift/oxlint-config";\n' +
      'import { SEMANTIC_FACT_KINDS, SEMANTIC_FACT_KIND_CONTRACT_LIST, SEMANTIC_FACT_SCHEMA_VERSION, checkChanged, checkGenerated, checkRegistries, createJsonlFactSink, createMemoryFactSink, defaultAstGrepBinary, DEFAULT_AST_GREP_CONFIG, generate, loadPolicy as loadPolicyFromPolicy, loadRegistriesSync as loadRegistriesFromPolicy, parseOxlintArgs, parseShellGuardrailsArgs, renderPolicyArtifacts as renderPolicyArtifactsFromPolicy, runOxlint, semanticFact, semanticFactKindContractsForAdapterId, semanticFactKindContractsForConfidence, semanticFactKindContractsForEmission, semanticFactKindContractsForRule, semanticFactToJsonLine, shellGuardrails, verifySession } from "@joedeleeuw/antidrift/policy";\n' +
      "\n" +
      "const exportsToCheck = {\n" +
      "  complexityRules, toolingOxlint, typescriptSyntaxRules, typescriptTypeAwareRules, typescriptBaselineTier, adoptionPresets, createAdoptionOxlintConfig,\n" +
      "  createGovernanceOxlintConfig,\n" +
      "  createGovernanceOxlintConfigFromSubpath,\n" +
      "  loadPolicy,\n" +
      "  loadRegistriesSync,\n" +
      "  renderPolicyArtifacts,\n" +
      "  brand,\n" +
      "  checkChanged,\n" +
      "  checkGenerated,\n" +
      "  checkRegistries,\n" +
      "  defaultAstGrepBinary,\n" +
      "  DEFAULT_AST_GREP_CONFIG,\n" +
      "  generate,\n" +
      "  loadPolicyFromPolicy,\n" +
      "  loadRegistriesFromPolicy,\n" +
      "  parseOxlintArgs,\n" +
      "  parseShellGuardrailsArgs,\n" +
      "  renderPolicyArtifactsFromPolicy,\n" +
      "  SEMANTIC_FACT_KINDS,\n" +
      "  SEMANTIC_FACT_KIND_CONTRACT_LIST,\n" +
      "  SEMANTIC_FACT_SCHEMA_VERSION,\n" +
      "  semanticFactKindContractsForAdapterId,\n" +
      "  semanticFactKindContractsForConfidence,\n" +
      "  semanticFactKindContractsForEmission,\n" +
      "  semanticFactKindContractsForRule,\n" +
      "  createJsonlFactSink,\n" +
      "  createMemoryFactSink,\n" +
      "  semanticFact,\n" +
      "  semanticFactToJsonLine,\n" +
      "  runOxlint,\n" +
      "  shellGuardrails,\n" +
      "  verifySession,\n" +
      "};\n" +
      'if ("createOxlintConfig" in antidriftPackage || "eslintPlugin" in antidriftPackage || "oxlintPlugin" in antidriftPackage) {\n' +
      '  throw new Error("legacy plugin or config API remains exported");\n' +
      "}\n" +
      "if (typeof packageMetadata.version !== 'string') {\n" +
      '  throw new Error("package.json metadata must expose version");\n' +
      "}\n" +
      "for (const [name, value] of Object.entries(exportsToCheck)) {\n" +
      '  if (typeof value !== "function" && typeof value !== "object" && typeof value !== "number" && typeof value !== "string") {\n' +
      "    throw new Error(`Missing runtime export: ${name}`);\n" +
      "  }\n" +
      "}\n" +
      'const runtimeOxlintArgs = parseOxlintArgs([], { cwd: ".", exists: () => false });\n' +
      'if (runtimeOxlintArgs.targets.join(",") !== ".") {\n' +
      '  throw new Error("Missing oxlint policy export behavior");\n' +
      "}\n" +
      'if (!SEMANTIC_FACT_KINDS.structuralMatch.payloadFields.includes("ownerType")) {\n' +
      '  throw new Error("Missing structuralMatch semantic fact contract");\n' +
      "}\n"
  );
}
