import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const work = mkdtempSync(join(tmpdir(), "antidrift-consumer-"));

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 300_000,
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function runJson(cmd, args, cwd) {
  return JSON.parse(run(cmd, args, cwd));
}

function file(rel, contents) {
  const path = join(work, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf8");
}

function fail(message) {
  console.error(`\n✗ ${message}`);
  console.error(`  (left workspace for inspection: ${work})`);
  process.exit(1);
}

try {
  console.log("1/7  packing @joedeleeuw/antidrift ...");
  run("pnpm", ["pack", "--pack-destination", work], pkgDir);
  const tgz = readdirSync(work).find((f) => f.endsWith(".tgz"));
  if (!tgz) fail("pack produced no tarball");
  const tarball = join(work, tgz);

  console.log("2/7  scaffolding a consumer pnpm workspace ...");
  file("pnpm-workspace.yaml", "packages:\n  - packages/*\n");
  file(
    "policy/registries/generated.yaml",
    "generatedSources:\n" +
      "  appGenerated:\n" +
      "    generated: packages/app/src/generated\n",
  );
  file(
    "policy/registries/rules.yaml",
    "schemaVersion: 1\n" +
      "promotionRequirements:\n" +
      "  stable:\n" +
      "    minIndependentRepositories: 2\n" +
      "rules:\n" +
      "  antidrift/no-structural-type-fork:\n" +
      "    status: ready\n" +
      "    stable: false\n" +
      "    signal: TypeChecker plus authority index\n" +
      "    solveType: generated-type-drift\n" +
      "    corpusRepositories: [consumer]\n" +
      "    external:\n" +
      "      state: net-antidrift\n" +
      "      support: none\n" +
      "      candidates: []\n" +
      "      decision: own-antidrift\n" +
      "      whyThisState: Test package authority.\n" +
      "      whyNotOtherState: Test package authority.\n" +
      "    examples:\n" +
      '      flags: ["type ReleaseRow = {}"]\n' +
      '      allows: ["import type { GeneratedRelease } from ./generated/release"]\n' +
      "    nextAction: Keep owner facts explicit.\n" +
      "  antidrift/no-async-array-method:\n" +
      "    status: ready\n" +
      "    stable: false\n" +
      "    signal: AST default branch plus opt-in local collection flow\n" +
      "    solveType: promise-control-flow\n" +
      "    proofBuckets: [local-ast-source-shape, semantic-source-type-provenance]\n" +
      "    nextAction: Keep async collection proof explicit and opt-in.\n" +
      "  antidrift/no-handrolled-resource-lifecycle-cells:\n" +
      "    status: ready\n" +
      "    stable: false\n" +
      "    signal: source binding plus local transition/control-flow proof\n" +
      "    solveType: react-state-shape\n" +
      "    nextAction: Keep lifecycle proof explicit.\n" +
      "  antidrift/no-nullable-positional-tuple:\n" +
      "    status: ready\n" +
      "    stable: false\n" +
      "    signal: deterministic AST\n" +
      "    solveType: type-contract-shape\n" +
      "    proofBuckets: [local-ast-source-shape, semantic-source-type-provenance]\n" +
      "    nextAction: Keep tuple shape proof explicit.\n" +
      "  antidrift/no-raw-fetch-in-component:\n" +
      "    status: ready\n" +
      "    stable: true\n" +
      "    signal: import-scope plus AST\n" +
      "    solveType: side-effect-boundary\n" +
      "    promotion:\n" +
      "      proofBucket: local-ast-source-shape\n" +
      "    nextAction: Keep local AST proof explicit.\n" +
      "retiredRules:\n" +
      "  antidrift/no-status-triplet-state:\n" +
      "    status: retired\n" +
      "    replacement: antidrift/no-handrolled-resource-lifecycle-cells\n" +
      "    reason: Name groups are inventory only.\n" +
      "researchCandidates:\n" +
      "  ecosystem/import-cycle:\n" +
      "    status: ecosystem-covered\n" +
      "    signal: import-graph\n" +
      "    solveType: semantic-architecture-drift\n" +
      "    replacement: import-x/no-cycle\n" +
      "    reason: Covered by shared ESLint config.\n" +
      "policyRuleReviews:\n" +
      "  agent/require-checks-before-stop:\n" +
      "    status: active-custom\n" +
      "    antidriftRule: agent/require-checks-before-stop\n" +
      "    coverage: Session fact.\n" +
      "    reason: Requires command history.\n" +
      "    nextAction: Keep in agent-ops.\n",
  );
  file(
    "package.json",
    JSON.stringify(
      {
        name: "antidrift-consumer-fixture",
        private: true,
        type: "module",
        devDependencies: {
          "@joedeleeuw/antidrift": `file:${tarball}`,
          eslint: "^9",
          "typescript-eslint": "^8",
          "@typescript-eslint/parser": "^8",
          typescript: "^5",
          firebase: "^11",
        },
      },
      null,
      2,
    ) + "\n",
  );
  const baseCompilerOptions = {
    target: "ES2022",
    module: "ESNext",
    moduleResolution: "Bundler",
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
      2,
    ) + "\n",
  );
  file(
    "tsconfig.bundler.json",
    JSON.stringify(
      {
        compilerOptions: {
          ...baseCompilerOptions,
        },
        include: ["packages/app/src/**/*.ts"],
      },
      null,
      2,
    ) + "\n",
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
      2,
    ) + "\n",
  );
  file(
    "eslint.config.mjs",
    'import { appendFileSync } from "node:fs";\n' +
      'import { createConfig } from "@joedeleeuw/antidrift/eslint-config";\n' +
      'import { createJsonlFactSink } from "@joedeleeuw/antidrift/policy";\n' +
      "\n" +
      'const factFile = new URL("./semantic-facts.jsonl", import.meta.url);\n' +
      "const sink = createJsonlFactSink((line) => appendFileSync(factFile, line));\n" +
      "\n" +
      "export default createConfig({\n" +
      "  tsconfigRootDir: import.meta.dirname,\n" +
      "  semanticFacts: { repoRoot: import.meta.dirname, sink },\n" +
      "});\n",
  );
  file(
    "eslint.structural.config.mjs",
    'import { appendFileSync } from "node:fs";\n' +
      'import { createConfig } from "@joedeleeuw/antidrift/eslint-config";\n' +
      'import { createJsonlFactSink } from "@joedeleeuw/antidrift/policy";\n' +
      "\n" +
      'const factFile = new URL("./semantic-facts.jsonl", import.meta.url);\n' +
      "const sink = createJsonlFactSink((line) => appendFileSync(factFile, line));\n" +
      "\n" +
      "export default [\n" +
      "  ...createConfig({\n" +
      "    tsconfigRootDir: import.meta.dirname,\n" +
      "    semanticFacts: { repoRoot: import.meta.dirname, sink },\n" +
      "  }),\n" +
      "  {\n" +
      "    rules: {\n" +
      '      "antidrift/no-structural-type-fork": ["error", { generatedSources: { appGenerated: { generated: "packages/app/src/generated" } }, packageTypeOwners: {} }],\n' +
      "    },\n" +
      "  },\n" +
      "];\n",
  );
  file(
    "eslint.async-array.config.mjs",
    'import { createConfig } from "@joedeleeuw/antidrift/eslint-config";\n' +
      "\n" +
      "export default [\n" +
      "  ...createConfig({ tsconfigRootDir: import.meta.dirname }),\n" +
      "  {\n" +
      "    rules: {\n" +
      '      "antidrift/no-async-array-method": "error",\n' +
      "    },\n" +
      "  },\n" +
      "];\n",
  );
  file(
    "eslint.async-array-collection.config.mjs",
    'import { createConfig } from "@joedeleeuw/antidrift/eslint-config";\n' +
      "\n" +
      "export default [\n" +
      "  ...createConfig({ tsconfigRootDir: import.meta.dirname }),\n" +
      "  {\n" +
      "    rules: {\n" +
      '      "antidrift/no-async-array-method": ["error", { branches: ["requires-collection"] }],\n' +
      "    },\n" +
      "  },\n" +
      "];\n",
  );
  file(
    "packages/app/tsconfig.json",
    JSON.stringify(
      {
        extends: "../../tsconfig.base.json",
        include: ["src/**/*.ts"],
      },
      null,
      2,
    ) + "\n",
  );
  file(
    "packages/app/src/clean.ts",
    'import type { User } from "firebase/auth";\n' +
      'export function displayName(u: User): string {\n  return u.displayName ?? "anon";\n}\n',
  );
  file(
    "packages/app/src/generated/release.ts",
    "export type GeneratedRelease = {\n" +
      "  id: string;\n  appId: string;\n  version: string;\n" +
      '  status: "draft" | "submitted" | "released";\n  createdAt: number;\n};\n',
  );
  file(
    "packages/app/src/drift.ts",
    "export type ReleaseRow = {\n" +
      "  id: string;\n  appId: string;\n  version: string;\n" +
      '  status: "draft" | "submitted" | "released";\n  createdAt: number;\n};\n',
  );
  file(
    "packages/app/src/package-copy.ts",
    "export type AuthUser = {\n" +
      "  uid: string;\n  email: string | null;\n  displayName: string | null;\n" +
      "  photoURL: string | null;\n  providerId: string;\n  phoneNumber: string | null;\n};\n",
  );
  file(
    "packages/app/src/async-foreach-drift.ts",
    "export function cleanup(items: Array<{ save(): Promise<void> }>) {\n" +
      "  items.forEach(async (item) => {\n" +
      "    await item.save();\n" +
      "  });\n" +
      "}\n",
  );
  file(
    "packages/app/src/async-map-collection-drift.ts",
    "export function countPending(items: Array<{ save(): Promise<void> }>) {\n" +
      "  const pending = items.map(async (item) => {\n" +
      "    await item.save();\n" +
      "  });\n" +
      "  return pending.length;\n" +
      "}\n",
  );
  file(
    "packages/app/src/async-map-return-clean.ts",
    "export function pendingSaves(items: Array<{ save(): Promise<void> }>) {\n" +
      "  const pending = items.map(async (item) => {\n" +
      "    await item.save();\n" +
      "  });\n" +
      "  return pending;\n" +
      "}\n",
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
      "rawLiteral satisfies string;\n",
  );
  file(
    "packages/app/src/exports.ts",
    'import type { ESLint, Linter } from "eslint";\n' +
      'import type * as ts from "typescript";\n' +
      'import { createConfig, eslintPlugin, loadPolicy, loadRegistriesSync, renderPolicyArtifacts, type AgentGuardrailsPolicy, type AntidriftConfigOptions, type AntidriftRegistries, type PolicyArtifacts } from "@joedeleeuw/antidrift";\n' +
      'import { brand, type Brand, type BrandKit, type BrandSafeResult, type Unbrand } from "@joedeleeuw/antidrift/brand";\n' +
      'import plugin from "@joedeleeuw/antidrift/eslint-plugin";\n' +
      'import { createConfig as createConfigFromSubpath, type AntidriftConfigOptions as SubpathConfigOptions } from "@joedeleeuw/antidrift/eslint-config";\n' +
      'import { SEMANTIC_FACT_KINDS, SEMANTIC_FACT_KIND_CONTRACT_LIST, SEMANTIC_FACT_SCHEMA_VERSION, checkGenerated, checkRegistries, checkRuleSurface, classifyReactStateFact, classifySqlParserServiceDelta, createJsonlFactSink, createMemoryFactSink, declarationCloneInventory, defensiveShapeInventory, eslintJsonToSonar, externalCorpus, generate, loadPolicy as loadPolicyFromPolicy, loadRegistriesSync as loadRegistriesFromPolicy, loadRuleStatusRegistrySync, reactStateInventory, renderPolicyArtifacts as renderPolicyArtifactsFromPolicy, repoCorpus, ruleStatusEntriesForKind, ruleStatusEntriesForProofBucket, ruleStatusEntriesForSemanticAdapter, ruleStatusEntriesForStatus, ruleStatusEntryForId, ruleStatusManifest, ruleStatusSemanticSummaries, ruleStatusSemanticSummaryForId, semanticFact, semanticFactKindContractsForAdapterId, semanticFactKindContractsForConfidence, semanticFactKindContractsForEmission, semanticFactKindContractsForRule, semanticFactToJsonLine, undercheckedPredicateInventory, verifySession, type AgentGuardrailsPolicy as PolicySubpathPolicy, type RuleStatusManifest, type RuleStatusManifestEntry, type RuleStatusPromotion, type RuleStatusSemanticSummary, type SemanticFact, type SemanticFactKind, type SemanticFactKindContractEntry, type SqlParserServiceDeltaClassification } from "@joedeleeuw/antidrift/policy";\n' +
      'import { SEMANTIC_ADAPTERS, SEMANTIC_ADAPTER_CONTRACTS, SEMANTIC_ADAPTER_CONTRACT_LIST, SEMANTIC_ADAPTER_MANIFEST, asyncControlFlow as adapterAsyncControlFlow, authBoundary as adapterAuthBoundary, broadInput as adapterBroadInput, parseInput as adapterParseInput, reactState as adapterReactState, schemaProvenance as adapterSchemaProvenance, semanticAdapterContractsForFactAdapterId, semanticAdapterContractsForFactKind, semanticAdapterContractsForProofBucket, semanticAdapterContractsForRule, semanticAdapterManifestForAdapterId, semanticAdapterManifestForFactAdapterId, semanticAdapterManifestForFactKind, semanticAdapterManifestForProofBucket, semanticAdapterManifestForRule, sql as adapterSql, tupleShape as adapterTupleShape, typeOwner as adapterTypeOwner, type SemanticAdapterContract, type SemanticAdapterContractKey, type SemanticAdapterManifestEntry } from "@joedeleeuw/antidrift/semantic-adapters";\n' +
      'import { REQUEST_PARAM_ROOTS, callExpressionName, createAuthBoundaryTracker, isAuthzCall, isRequestParamsAccess, type AuthBoundaryFrame, type AuthBoundaryTracker } from "@joedeleeuw/antidrift/semantic-adapters/auth-boundary";\n' +
      'import { ASYNC_ARRAY_METHODS_NEVER_AWAIT, ASYNC_ARRAY_METHODS_REQUIRE_COLLECTION, PROMISE_COMBINATOR_METHODS, asyncArrayCallbackClassification, asyncCallbackArgument, findVariable, getDeclaredVariable, isDirectlyWrappedInPromiseCombinator, isPromiseCombinator, isReturnedExpression, markAwaitedPendingMaps, markReturnedPendingMaps, promiseCombinatorVariables, queuePendingAsyncMap, type AsyncArrayCallbackClassification, type PendingAsyncMap } from "@joedeleeuw/antidrift/semantic-adapters/async-control-flow";\n' +
      'import { BROAD_INPUT_ARRAY_TRANSFORM_METHODS, assignmentTarget, callUsesPredicateParam, checkedTargetProperties, collectBindingIdentifiers, collectBindingNames, collectObjectPatternBindingNames, countShapeProbesIn, destructuredTargetPropertyAliases, directAliasName, functionParameterByName, hasBroadObjectEntriesValue, hasParamRoot, hasValidatorDelegation, isAppeasementCastSourceType, isAppeasementCastTargetType, isAppeasementContractCast, isBindingIdentifier, isBroadPredicateInputType, isBroadShapeProbeInputType, isNamedTypeReference, isNullishLiteral, isObjectEntriesCall, isPredicateObjectContract, isTypeofObjectProbe, memberExpressionPropertyName, memberExpressionRootName, objectEntriesCallbackProbe, objectEntriesValueBindings, objectHasOwnPropertyName, predicateValueNames, requiredTypeProps, staticPropertyName, typePredicateParts, unwrapExpression, walkNode, type ObjectEntriesCallbackProbe, type TypePredicateParts, type TypeScriptParserServices as BroadInputParserServices } from "@joedeleeuw/antidrift/semantic-adapters/broad-input";\n' +
      'import { conditionEnsuresString, hasLocalStringBoundary, isJsonParseCall, isUnsafeJsonParseInput, jsonParseArgument, type TypeScriptParserServices as ParseInputParserServices } from "@joedeleeuw/antidrift/semantic-adapters/parse-input";\n' +
      'import { classifyWriteValue, createReactStateTracker, frameStatePayload, lifecycleProof, type ReactStateFrame, type ReactStateFramePayload, type ReactStateLifecycleProof, type ReactStateWriteClass } from "@joedeleeuw/antidrift/semantic-adapters/react-state";\n' +
      'import { ZOD_PARSE_METHODS, ZOD_THROW_ASSERTION_MATCHERS, isAwaitedCallInitializer, isCallResultExpression, isThrowAssertionCallbackParse, isZodParseExpression, parsedCallResultMatchesSchemaOutput, recordParsedConst, zodParseCallParts, type TypeScriptParserServices, type ZodParseCallParts } from "@joedeleeuw/antidrift/semantic-adapters/schema-provenance";\n' +
      'import { isSqlDirectionTokenValue, isSqlIdentifierContext, isSqlIdentifierTokenValue, isSqlInterpolationContext, normalizedSqlContext, removeTrailingSqlQuote, safeIdentifierMemberSpecs, safeTemplateTagSpecs, valuesAreSqlDirections, valuesAreSqlIdentifiers, type SafeIdentifierMemberSpec, type SafeTemplateTagSpecs } from "@joedeleeuw/antidrift/semantic-adapters/sql";\n' +
      'import { hasNullablePositionalTuple, nullableTupleSlots, tupleElementIsNullishSlot, tupleElementIsOptional, tupleElementResolvesToNullish, tupleElementTypeNode, typeIncludesNullish, typeNodeIncludesDirectNullish, type TypeScriptParserServices as TupleShapeParserServices } from "@joedeleeuw/antidrift/semantic-adapters/tuple-shape";\n' +
      'import { MIN_PROPS, canonicalStatusLiteralOwner, collectAcceptedPackageCanonicalTypes, collectCanonicalTypes, collectDomainCanonicalTypes, collectGeneratedCanonicalTypes, isObjectType, isStatusContextName, isStatusLiteralContext, normalizedContextName, nodeKeyName, resolvesToDomainCanonicalType, resolvesToGeneratedType, resolvesToInstalledType, typeProps, type DomainCanonicalEntityRegistry, type DomainStatusRegistry, type GeneratedSourceRegistry, type PackageTypeOwnerRegistry, type StatusLiteralOwner, type StructuralTypeCandidate } from "@joedeleeuw/antidrift/semantic-adapters/type-owner";\n' +
      "\n" +
      "const policy = { clusters: [] } satisfies AgentGuardrailsPolicy;\n" +
      "const subpathPolicy = policy satisfies PolicySubpathPolicy;\n" +
      "const artifacts = renderPolicyArtifacts(policy);\n" +
      'const semantic = semanticFact({ factKind: "test", ruleId: "antidrift/test", adapterId: "test", confidence: "deterministic-inventory", provenance: ["AST"], payload: {} });\n' +
      "const memorySink = createMemoryFactSink();\n" +
      "const jsonlSink = createJsonlFactSink(() => {});\n" +
      'const options = { tsconfigRootDir: ".", semanticFacts: { sink: memorySink } } satisfies AntidriftConfigOptions;\n' +
      'const subpathOptions = { policyDir: "policy", semanticFacts: { sink: memorySink } } satisfies SubpathConfigOptions;\n' +
      'const branded = brand("UserId", (value): value is string => typeof value === "string");\n' +
      'const authBoundaryTracker = createAuthBoundaryTracker({ authzFunctions: ["authorize"], onFrameExit(frame) { frame satisfies AuthBoundaryFrame; } });\n' +
      'const writeClass = classifyWriteValue({ type: "Literal", value: false }, { awaitedNames: new Set<string>(), catchParams: [] });\n' +
      "const reactSourceCode = { getScope: (_node: unknown) => ({ set: new Map<string, unknown>(), upper: null }), getDeclaredVariables: (_node: unknown) => [] };\n" +
      "const tracker = createReactStateTracker({ sourceCode: reactSourceCode, onFrameExit(frame) { frame satisfies ReactStateFrame; } });\n" +
      "const parserServices = { esTreeNodeToTSNodeMap: { get: (_node: unknown) => undefined } } satisfies TypeScriptParserServices;\n" +
      "const broadParserServices = parserServices satisfies BroadInputParserServices;\n" +
      "const parseParserServices = parserServices satisfies ParseInputParserServices;\n" +
      "const tupleParserServices = parserServices satisfies TupleShapeParserServices;\n" +
      'const safeIdentifierMembers = safeIdentifierMemberSpecs({ safeIdentifierMembers: [{ type: "SourceTable", member: "escapedIdentifier" }, { type: 1, member: "bad" }] });\n' +
      'const safeTemplateTags = safeTemplateTagSpecs({ safeTemplateTags: [{ module: "drizzle-orm", export: "sql", evidence: "builder" }, { type: "Agent", member: "sql", source: "packages/agents/src/index.ts", evidence: "member" }, { type: "Agent", member: "sql" }] });\n' +
      'const jsonParseCall = { type: "CallExpression", callee: { type: "MemberExpression", object: { type: "Identifier", name: "JSON" }, property: { type: "Identifier", name: "parse" } }, arguments: [{ type: "Identifier", name: "raw" }] };\n' +
      'const generatedRegistry = { appGenerated: { generated: "packages/app/src/generated" } } satisfies GeneratedSourceRegistry;\n' +
      'const packageOwners = { firebaseAuthUser: { package: "@firebase/auth", exportName: "User", reason: "test owner" } } satisfies PackageTypeOwnerRegistry;\n' +
      'const domainEntities = { Release: { owner: "packages/domain/src/release.ts" } } satisfies DomainCanonicalEntityRegistry;\n' +
      'const domainStatuses = { UserStatus: { owner: "packages/domain/src/user.ts", values: ["active", "disabled"] } } satisfies DomainStatusRegistry;\n' +
      'const statusLiteral = { type: "TSLiteralType", literal: { value: "active" }, parent: { type: "TSTypeAliasDeclaration", id: { name: "UserStatus" } } };\n' +
      "const statusLiteralOwner = canonicalStatusLiteralOwner(statusLiteral, domainStatuses);\n" +
      'const nullableTuple = { type: "TSTupleType", elementTypes: [{ type: "TSUnionType", types: [{ type: "TSStringKeyword" }, { type: "TSNullKeyword" }] }, { type: "TSOptionalType", typeAnnotation: { type: "TSNumberKeyword" } }] };\n' +
      'const ownerCandidate = { label: "generated#Release", props: new Map<string, string>(), authority: "generated-source", authorityState: "accepted" } satisfies StructuralTypeCandidate;\n' +
      'const ruleStatusRegistry = loadRuleStatusRegistrySync("policy");\n' +
      "const ruleStatus = ruleStatusManifest(ruleStatusRegistry);\n" +
      'const coupledStateSummary = ruleStatusSemanticSummaryForId("antidrift/no-handrolled-resource-lifecycle-cells", ruleStatus);\n' +
      'const asyncCallback = { type: "ArrowFunctionExpression", async: true };\n' +
      'const asyncMapCall = { type: "CallExpression", callee: { type: "MemberExpression", object: { type: "Identifier", name: "items" }, property: { type: "Identifier", name: "map" } }, arguments: [asyncCallback] };\n' +
      "const asyncClassification = asyncArrayCallbackClassification(asyncMapCall);\n" +
      "\n" +
      "asyncClassification satisfies AsyncArrayCallbackClassification | null;\n" +
      "asyncCallbackArgument(asyncMapCall) satisfies unknown | null;\n" +
      'ASYNC_ARRAY_METHODS_NEVER_AWAIT.has("forEach") satisfies boolean;\n' +
      'ASYNC_ARRAY_METHODS_REQUIRE_COLLECTION.has("map") satisfies boolean;\n' +
      'PROMISE_COMBINATOR_METHODS.has("all") satisfies boolean;\n' +
      'isPromiseCombinator({ type: "MemberExpression", object: { type: "Identifier", name: "Promise" }, property: { type: "Identifier", name: "all" } }) satisfies boolean;\n' +
      "isDirectlyWrappedInPromiseCombinator(asyncMapCall) satisfies boolean;\n" +
      "isReturnedExpression(asyncMapCall) satisfies boolean;\n" +
      "markAwaitedPendingMaps satisfies (sourceCode: unknown, node: unknown, pendingAsyncMaps: PendingAsyncMap[]) => void;\n" +
      "markReturnedPendingMaps satisfies (sourceCode: unknown, node: unknown, pendingAsyncMaps: PendingAsyncMap[]) => void;\n" +
      "promiseCombinatorVariables satisfies (sourceCode: unknown, node: unknown) => unknown[];\n" +
      "queuePendingAsyncMap satisfies (sourceCode: unknown, node: unknown, callback: unknown, method: string, pendingAsyncMaps: PendingAsyncMap[]) => boolean;\n" +
      "getDeclaredVariable satisfies (sourceCode: unknown, declarator: unknown) => unknown | null;\n" +
      "findVariable satisfies (sourceCode: unknown, identifier: unknown) => unknown | null;\n" +
      "conditionEnsuresString({ type: \"Literal\", value: true }, jsonParseCall.arguments[0], true) satisfies boolean;\n" +
      "hasLocalStringBoundary(jsonParseCall, jsonParseCall.arguments[0]) satisfies boolean;\n" +
      "isJsonParseCall(jsonParseCall) satisfies boolean;\n" +
      "jsonParseArgument(jsonParseCall) satisfies unknown | null;\n" +
      "isUnsafeJsonParseInput satisfies (node: unknown, services: ParseInputParserServices, checker: ts.TypeChecker) => boolean;\n" +
      "isAppeasementCastSourceType satisfies (type: ts.Type | null | undefined) => boolean;\n" +
      "isAppeasementCastTargetType satisfies (type: ts.Type | null | undefined) => boolean;\n" +
      "isAppeasementContractCast satisfies (node: unknown, services: BroadInputParserServices, checker: ts.TypeChecker) => boolean;\n" +
      "isNamedTypeReference({ type: \"TSTypeReference\" }) satisfies boolean;\n" +
      "void parseParserServices;\n" +
      "void tupleParserServices;\n" +
      "createConfig(options) satisfies Linter.Config[];\n" +
      "createConfigFromSubpath(subpathOptions) satisfies Linter.Config[];\n" +
      "eslintPlugin satisfies ESLint.Plugin;\n" +
      "plugin satisfies ESLint.Plugin;\n" +
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
      "ruleStatus satisfies RuleStatusManifest;\n" +
      "ruleStatus.entries satisfies readonly RuleStatusManifestEntry[];\n" +
      'const rawFetchPromotion = ruleStatusEntryForId("antidrift/no-raw-fetch-in-component", ruleStatus)?.promotion;\n' +
      "rawFetchPromotion satisfies RuleStatusPromotion | undefined;\n" +
      "rawFetchPromotion?.proofBucket satisfies string | undefined;\n" +
      "statusLiteralOwner satisfies StatusLiteralOwner | null;\n" +
      "safeTemplateTags satisfies SafeTemplateTagSpecs;\n" +
      'normalizedContextName("User Status") satisfies string;\n' +
      'isStatusContextName("user_status", "UserStatus") satisfies boolean;\n' +
      'isStatusLiteralContext(statusLiteral, "UserStatus") satisfies boolean;\n' +
      'nodeKeyName({ type: "Identifier", name: "status" }) satisfies string;\n' +
      'ruleStatusEntryForId("antidrift/no-structural-type-fork", ruleStatus) satisfies RuleStatusManifestEntry | null;\n' +
      'ruleStatusEntriesForKind("research", ruleStatus) satisfies readonly RuleStatusManifestEntry[];\n' +
      'ruleStatusEntriesForProofBucket("authority-index-ownership", ruleStatus) satisfies readonly RuleStatusManifestEntry[];\n' +
      'ruleStatusEntriesForSemanticAdapter("type-owner", ruleStatus) satisfies readonly RuleStatusManifestEntry[];\n' +
      'ruleStatusEntriesForStatus("retired", ruleStatus) satisfies readonly RuleStatusManifestEntry[];\n' +
      "coupledStateSummary satisfies RuleStatusSemanticSummary | null;\n" +
      "ruleStatusSemanticSummaries(ruleStatus) satisfies readonly RuleStatusSemanticSummary[];\n" +
      'semanticFactKindContractsForAdapterId("react-state") satisfies readonly SemanticFactKindContractEntry[];\n' +
      'semanticFactKindContractsForConfidence("deterministic-enforcement") satisfies readonly SemanticFactKindContractEntry[];\n' +
      'semanticFactKindContractsForEmission("blocking-diagnostic") satisfies readonly SemanticFactKindContractEntry[];\n' +
      'semanticFactKindContractsForRule("antidrift/no-handrolled-resource-lifecycle-cells") satisfies readonly SemanticFactKindContractEntry[];\n' +
      '"structuralMatch" satisfies SemanticFactKind;\n' +
      "SEMANTIC_FACT_SCHEMA_VERSION satisfies 1;\n" +
      "SEMANTIC_ADAPTERS.authBoundary satisfies typeof adapterAuthBoundary;\n" +
      "SEMANTIC_ADAPTERS.asyncControlFlow satisfies typeof adapterAsyncControlFlow;\n" +
      "SEMANTIC_ADAPTERS.broadInput satisfies typeof adapterBroadInput;\n" +
      "SEMANTIC_ADAPTERS.parseInput satisfies typeof adapterParseInput;\n" +
      "SEMANTIC_ADAPTERS.reactState satisfies typeof adapterReactState;\n" +
      "SEMANTIC_ADAPTERS.schemaProvenance satisfies typeof adapterSchemaProvenance;\n" +
      "SEMANTIC_ADAPTERS.sql satisfies typeof adapterSql;\n" +
      "SEMANTIC_ADAPTERS.tupleShape satisfies typeof adapterTupleShape;\n" +
      "SEMANTIC_ADAPTERS.typeOwner satisfies typeof adapterTypeOwner;\n" +
      '"authBoundary" satisfies SemanticAdapterContractKey;\n' +
      '"asyncControlFlow" satisfies SemanticAdapterContractKey;\n' +
      '"tupleShape" satisfies SemanticAdapterContractKey;\n' +
      "SEMANTIC_ADAPTER_CONTRACTS.authBoundary satisfies SemanticAdapterContract;\n" +
      "SEMANTIC_ADAPTER_CONTRACTS.asyncControlFlow.rules satisfies readonly string[];\n" +
      "SEMANTIC_ADAPTER_CONTRACT_LIST satisfies readonly SemanticAdapterContract[];\n" +
      "SEMANTIC_ADAPTER_MANIFEST satisfies readonly SemanticAdapterManifestEntry[];\n" +
      "SEMANTIC_ADAPTER_CONTRACTS.broadInput.rules satisfies readonly string[];\n" +
      "SEMANTIC_ADAPTER_CONTRACTS.parseInput.rules satisfies readonly string[];\n" +
      "SEMANTIC_ADAPTER_CONTRACTS.schemaProvenance.proofBuckets satisfies readonly string[];\n" +
      "SEMANTIC_ADAPTER_CONTRACTS.reactState.semanticFactAdapterIds satisfies readonly string[];\n" +
      "SEMANTIC_ADAPTER_CONTRACTS.reactState.semanticFactKinds satisfies readonly string[];\n" +
      "SEMANTIC_ADAPTER_CONTRACTS.sql.associations satisfies readonly string[];\n" +
      "SEMANTIC_ADAPTER_CONTRACTS.tupleShape.rules satisfies readonly string[];\n" +
      "hasNullablePositionalTuple(nullableTuple) satisfies boolean;\n" +
      "nullableTupleSlots(nullableTuple) satisfies unknown[];\n" +
      "tupleElementIsNullishSlot(nullableTuple.elementTypes[0]) satisfies boolean;\n" +
      "tupleElementIsOptional(nullableTuple.elementTypes[1]) satisfies boolean;\n" +
      "tupleElementResolvesToNullish(nullableTuple.elementTypes[0], tupleParserServices) satisfies boolean;\n" +
      "tupleElementTypeNode(nullableTuple.elementTypes[1]) satisfies unknown;\n" +
      "typeIncludesNullish satisfies (type: ts.Type | null | undefined) => boolean;\n" +
      "typeNodeIncludesDirectNullish(nullableTuple.elementTypes[0]) satisfies boolean;\n" +
      'semanticAdapterContractsForRule("antidrift/no-handrolled-resource-lifecycle-cells") satisfies readonly SemanticAdapterContract[];\n' +
      'semanticAdapterContractsForRule("antidrift/no-async-array-method") satisfies readonly SemanticAdapterContract[];\n' +
      'semanticAdapterContractsForRule("antidrift/no-nullable-positional-tuple") satisfies readonly SemanticAdapterContract[];\n' +
      'semanticAdapterContractsForRule("antidrift/no-unsafe-deserialize") satisfies readonly SemanticAdapterContract[];\n' +
      'semanticAdapterContractsForFactAdapterId("react-state") satisfies readonly SemanticAdapterContract[];\n' +
      'semanticAdapterContractsForFactKind("resourceLifecycleProof") satisfies readonly SemanticAdapterContract[];\n' +
      'semanticAdapterContractsForProofBucket("semantic-source-type-provenance") satisfies readonly SemanticAdapterContract[];\n' +
      'semanticAdapterManifestForAdapterId("react-state")?.semanticFactContracts satisfies readonly SemanticFactKindContractEntry[] | undefined;\n' +
      'semanticAdapterManifestForAdapterId("parse-input")?.rules satisfies readonly string[] | undefined;\n' +
      'semanticAdapterManifestForRule("antidrift/no-handrolled-resource-lifecycle-cells") satisfies readonly SemanticAdapterManifestEntry[];\n' +
      'semanticAdapterManifestForRule("antidrift/no-async-array-method") satisfies readonly SemanticAdapterManifestEntry[];\n' +
      'semanticAdapterManifestForRule("antidrift/no-nullable-positional-tuple") satisfies readonly SemanticAdapterManifestEntry[];\n' +
      'semanticAdapterManifestForRule("antidrift/no-unsafe-deserialize") satisfies readonly SemanticAdapterManifestEntry[];\n' +
      'semanticAdapterManifestForFactAdapterId("react-state") satisfies readonly SemanticAdapterManifestEntry[];\n' +
      'semanticAdapterManifestForFactKind("resourceLifecycleProof") satisfies readonly SemanticAdapterManifestEntry[];\n' +
      'semanticAdapterManifestForProofBucket("authority-index-ownership") satisfies readonly SemanticAdapterManifestEntry[];\n' +
      "REQUEST_PARAM_ROOTS satisfies readonly string[];\n" +
      'callExpressionName({ type: "Identifier", name: "authorize" }) satisfies string | null;\n' +
      'isAuthzCall({ type: "Identifier", name: "authorize" }, ["authorize"]) satisfies boolean;\n' +
      'isRequestParamsAccess({ type: "MemberExpression", object: { type: "Identifier", name: "req" }, property: { type: "Identifier", name: "params" } }) satisfies boolean;\n' +
      "authBoundaryTracker satisfies AuthBoundaryTracker;\n" +
      'BROAD_INPUT_ARRAY_TRANSFORM_METHODS.has("map") satisfies boolean;\n' +
      "unwrapExpression satisfies (expression: unknown) => unknown;\n" +
      "assignmentTarget satisfies (node: unknown) => unknown;\n" +
      "collectBindingNames satisfies (node: unknown, names: Set<string>) => void;\n" +
      "collectObjectPatternBindingNames satisfies (pattern: unknown, names: Set<string>) => void;\n" +
      "collectBindingIdentifiers satisfies (node: unknown, identifiers: unknown[]) => void;\n" +
      'memberExpressionRootName({ type: "MemberExpression", object: { type: "Identifier", name: "value" }, property: { type: "Identifier", name: "field" } }) satisfies string | null;\n' +
      'hasParamRoot({ type: "MemberExpression", object: { type: "Identifier", name: "value" }, property: { type: "Identifier", name: "field" } }, new Set(["value"])) satisfies boolean;\n' +
      'isNullishLiteral({ type: "Literal", value: null }) satisfies boolean;\n' +
      'isObjectEntriesCall({ type: "CallExpression", callee: { type: "MemberExpression", object: { type: "Identifier", name: "Object" }, property: { type: "Identifier", name: "entries" } } }) satisfies boolean;\n' +
      "isTypeofObjectProbe satisfies (node: unknown, paramNames: ReadonlySet<string>) => boolean;\n" +
      "countShapeProbesIn satisfies (node: unknown, paramNames: ReadonlySet<string>) => number;\n" +
      "objectEntriesValueBindings satisfies (callback: unknown, methodName: string) => unknown[];\n" +
      "objectEntriesCallbackProbe satisfies (node: unknown) => ObjectEntriesCallbackProbe | null;\n" +
      "hasBroadObjectEntriesValue satisfies (probe: ObjectEntriesCallbackProbe, services: BroadInputParserServices, checker: ts.TypeChecker) => boolean;\n" +
      "isBroadShapeProbeInputType satisfies (checker: ts.TypeChecker, type: ts.Type | null | undefined, seen?: Set<ts.Type>) => boolean;\n" +
      "walkNode satisfies (node: unknown, visit: (node: unknown) => void) => void;\n" +
      "typePredicateParts satisfies (fn: unknown) => TypePredicateParts | null;\n" +
      "functionParameterByName satisfies (fn: unknown, name: string) => unknown | null;\n" +
      "isBroadPredicateInputType satisfies (checker: ts.TypeChecker, type: ts.Type | null | undefined) => boolean;\n" +
      "isPredicateObjectContract satisfies (type: ts.Type | null | undefined) => boolean;\n" +
      "requiredTypeProps satisfies (checker: ts.TypeChecker, type: ts.Type) => Set<string>;\n" +
      "staticPropertyName satisfies (node: unknown) => string | null;\n" +
      "memberExpressionPropertyName satisfies (node: unknown) => string | null;\n" +
      "objectHasOwnPropertyName satisfies (node: unknown, paramNames: ReadonlySet<string>) => string | null;\n" +
      "directAliasName satisfies (node: unknown, paramNames: ReadonlySet<string>) => string | null;\n" +
      "predicateValueNames satisfies (node: unknown, paramName: string) => Set<string>;\n" +
      "destructuredTargetPropertyAliases satisfies (node: unknown, paramNames: ReadonlySet<string>, targetProps: ReadonlySet<string>) => Map<string, string>;\n" +
      "isBindingIdentifier satisfies (node: unknown) => boolean;\n" +
      "checkedTargetProperties satisfies (node: unknown, paramName: string, targetProps: ReadonlySet<string>) => Set<string>;\n" +
      "callUsesPredicateParam satisfies (node: unknown, paramName: string) => boolean;\n" +
      "hasValidatorDelegation satisfies (node: unknown, paramName: string, services: BroadInputParserServices, checker: ts.TypeChecker) => boolean;\n" +
      "broadParserServices satisfies BroadInputParserServices;\n" +
      "writeClass satisfies ReactStateWriteClass | null;\n" +
      "tracker.visitors satisfies Record<string, (node: unknown) => void>;\n" +
      "lifecycleProof satisfies (frame: ReactStateFrame) => ReactStateLifecycleProof;\n" +
      "frameStatePayload satisfies (frame: ReactStateFrame) => ReactStateFramePayload;\n" +
      'ZOD_PARSE_METHODS.has("parse") satisfies boolean;\n' +
      'ZOD_THROW_ASSERTION_MATCHERS.has("toThrow") satisfies boolean;\n' +
      'isAwaitedCallInitializer({ type: "AwaitExpression", argument: { type: "CallExpression" } }) satisfies boolean;\n' +
      'isCallResultExpression({ type: "CallExpression" }) satisfies boolean;\n' +
      "isThrowAssertionCallbackParse satisfies (node: unknown) => boolean;\n" +
      "zodParseCallParts satisfies (node: unknown, services: TypeScriptParserServices, checker: ts.TypeChecker) => ZodParseCallParts | null;\n" +
      "isZodParseExpression satisfies (node: unknown, services: TypeScriptParserServices, checker: ts.TypeChecker) => boolean;\n" +
      "parsedCallResultMatchesSchemaOutput satisfies (checker: ts.TypeChecker, services: TypeScriptParserServices, tsCall: ts.Node, arg: unknown) => boolean;\n" +
      "recordParsedConst satisfies (node: unknown, schemaSym: ts.Symbol | undefined, symbolOf: (node: unknown) => ts.Symbol | undefined, validatedBy: Map<ts.Symbol, ts.Symbol>) => void;\n" +
      "parserServices satisfies TypeScriptParserServices;\n" +
      'isSqlIdentifierTokenValue("users") satisfies boolean;\n' +
      'isSqlDirectionTokenValue("ASC") satisfies boolean;\n' +
      'isSqlIdentifierContext("FROM ", "") satisfies boolean;\n' +
      'isSqlInterpolationContext("SEL" + "ECT * FROM ", "") satisfies boolean;\n' +
      'normalizedSqlContext("select   *") satisfies string;\n' +
      'removeTrailingSqlQuote("FROM `") satisfies string;\n' +
      'valuesAreSqlIdentifiers(new Set(["users"])) satisfies boolean;\n' +
      'valuesAreSqlDirections(new Set(["DESC"])) satisfies boolean;\n' +
      "safeIdentifierMembers satisfies SafeIdentifierMemberSpec[];\n" +
      "MIN_PROPS satisfies 4;\n" +
      "generatedRegistry satisfies GeneratedSourceRegistry;\n" +
      "packageOwners satisfies PackageTypeOwnerRegistry;\n" +
      "domainEntities satisfies DomainCanonicalEntityRegistry;\n" +
      "ownerCandidate satisfies StructuralTypeCandidate;\n" +
      "collectGeneratedCanonicalTypes satisfies (program: ts.Program, checker: ts.TypeChecker, generatedSources?: GeneratedSourceRegistry) => StructuralTypeCandidate[];\n" +
      "collectAcceptedPackageCanonicalTypes satisfies (program: ts.Program, checker: ts.TypeChecker, packageTypeOwners?: PackageTypeOwnerRegistry) => StructuralTypeCandidate[];\n" +
      "collectDomainCanonicalTypes satisfies (program: ts.Program, checker: ts.TypeChecker, canonicalEntities?: DomainCanonicalEntityRegistry) => StructuralTypeCandidate[];\n" +
      "collectCanonicalTypes satisfies (program: ts.Program, checker: ts.TypeChecker) => StructuralTypeCandidate[];\n" +
      "typeProps satisfies (checker: ts.TypeChecker, type: ts.Type) => Map<string, string>;\n" +
      "isObjectType satisfies (type: ts.Type | null | undefined) => boolean;\n" +
      "resolvesToInstalledType satisfies (type: ts.Type | null | undefined) => boolean;\n" +
      "resolvesToGeneratedType satisfies (type: ts.Type | null | undefined, generatedSources?: GeneratedSourceRegistry) => boolean;\n" +
      "resolvesToDomainCanonicalType satisfies (type: ts.Type | null | undefined, canonicalEntities?: DomainCanonicalEntityRegistry) => boolean;\n" +
      "classifySqlParserServiceDelta(null) satisfies SqlParserServiceDeltaClassification;\n" +
      "semantic satisfies SemanticFact;\n" +
      "semanticFactToJsonLine(semantic) satisfies string;\n" +
      "memorySink.facts satisfies SemanticFact[];\n" +
      "jsonlSink.emit(semantic);\n" +
      'branded satisfies BrandKit<string, "UserId">;\n' +
      'branded.make("user_123") satisfies Brand<string, "UserId">;\n' +
      'branded.safe("user_123") satisfies BrandSafeResult<string, "UserId">;\n' +
      '"user_123" satisfies Unbrand<Brand<string, "UserId">>;\n' +
      "void checkGenerated;\n" +
      "void checkRegistries;\n" +
      "void checkRuleSurface;\n" +
      "void defensiveShapeInventory;\n" +
      "void eslintJsonToSonar;\n" +
      "void externalCorpus;\n" +
      "void generate;\n" +
      "void classifyReactStateFact;\n" +
      "void classifySqlParserServiceDelta;\n" +
      "void SEMANTIC_ADAPTERS;\n" +
      "void SEMANTIC_ADAPTER_CONTRACTS;\n" +
      "void adapterAuthBoundary;\n" +
      "void adapterBroadInput;\n" +
      "void adapterReactState;\n" +
      "void adapterSchemaProvenance;\n" +
      "void adapterSql;\n" +
      "void adapterTypeOwner;\n" +
      "void REQUEST_PARAM_ROOTS;\n" +
      "void callExpressionName;\n" +
      "void createAuthBoundaryTracker;\n" +
      "void isAuthzCall;\n" +
      "void isRequestParamsAccess;\n" +
      "void BROAD_INPUT_ARRAY_TRANSFORM_METHODS;\n" +
      "void unwrapExpression;\n" +
      "void assignmentTarget;\n" +
      "void collectBindingIdentifiers;\n" +
      "void collectBindingNames;\n" +
      "void collectObjectPatternBindingNames;\n" +
      "void countShapeProbesIn;\n" +
      "void destructuredTargetPropertyAliases;\n" +
      "void hasBroadObjectEntriesValue;\n" +
      "void hasParamRoot;\n" +
      "void isNullishLiteral;\n" +
      "void isObjectEntriesCall;\n" +
      "void isTypeofObjectProbe;\n" +
      "void isBroadShapeProbeInputType;\n" +
      "void memberExpressionPropertyName;\n" +
      "void memberExpressionRootName;\n" +
      "void objectEntriesCallbackProbe;\n" +
      "void objectEntriesValueBindings;\n" +
      "void objectHasOwnPropertyName;\n" +
      "void callUsesPredicateParam;\n" +
      "void checkedTargetProperties;\n" +
      "void directAliasName;\n" +
      "void functionParameterByName;\n" +
      "void hasValidatorDelegation;\n" +
      "void isBindingIdentifier;\n" +
      "void isBroadPredicateInputType;\n" +
      "void isPredicateObjectContract;\n" +
      "void predicateValueNames;\n" +
      "void requiredTypeProps;\n" +
      "void staticPropertyName;\n" +
      "void typePredicateParts;\n" +
      "void walkNode;\n" +
      "void classifyWriteValue;\n" +
      "void createReactStateTracker;\n" +
      "void frameStatePayload;\n" +
      "void lifecycleProof;\n" +
      "void ZOD_PARSE_METHODS;\n" +
      "void ZOD_THROW_ASSERTION_MATCHERS;\n" +
      "void isAwaitedCallInitializer;\n" +
      "void isCallResultExpression;\n" +
      "void isThrowAssertionCallbackParse;\n" +
      "void isZodParseExpression;\n" +
      "void parsedCallResultMatchesSchemaOutput;\n" +
      "void recordParsedConst;\n" +
      "void zodParseCallParts;\n" +
      "void isSqlDirectionTokenValue;\n" +
      "void isSqlIdentifierContext;\n" +
      "void isSqlIdentifierTokenValue;\n" +
      "void isSqlInterpolationContext;\n" +
      "void normalizedSqlContext;\n" +
      "void removeTrailingSqlQuote;\n" +
      "void safeIdentifierMemberSpecs;\n" +
      "void valuesAreSqlDirections;\n" +
      "void valuesAreSqlIdentifiers;\n" +
      "void collectAcceptedPackageCanonicalTypes;\n" +
      "void collectCanonicalTypes;\n" +
      "void collectDomainCanonicalTypes;\n" +
      "void collectGeneratedCanonicalTypes;\n" +
      "void isObjectType;\n" +
      "void resolvesToDomainCanonicalType;\n" +
      "void resolvesToGeneratedType;\n" +
      "void resolvesToInstalledType;\n" +
      "void typeProps;\n" +
      "void reactStateInventory;\n" +
      "void repoCorpus;\n" +
      "void undercheckedPredicateInventory;\n" +
      "void declarationCloneInventory;\n" +
      "void verifySession;\n",
  );
  file(
    "packages/app/src/runtime.mjs",
    'import { createConfig, eslintPlugin, loadPolicy, loadRegistriesSync, renderPolicyArtifacts } from "@joedeleeuw/antidrift";\n' +
      'import { brand } from "@joedeleeuw/antidrift/brand";\n' +
      'import plugin from "@joedeleeuw/antidrift/eslint-plugin";\n' +
      'import { createConfig as createConfigFromSubpath } from "@joedeleeuw/antidrift/eslint-config";\n' +
      'import { SEMANTIC_FACT_KINDS, SEMANTIC_FACT_KIND_CONTRACT_LIST, SEMANTIC_FACT_SCHEMA_VERSION, checkGenerated, checkRegistries, checkRuleSurface, classifyReactStateFact, classifySqlParserServiceDelta, createJsonlFactSink, createMemoryFactSink, declarationCloneInventory, defensiveShapeInventory, eslintJsonToSonar, externalCorpus, generate, loadPolicy as loadPolicyFromPolicy, loadRegistriesSync as loadRegistriesFromPolicy, loadRuleStatusRegistrySync, reactStateInventory, renderPolicyArtifacts as renderPolicyArtifactsFromPolicy, repoCorpus, ruleStatusEntriesForKind, ruleStatusEntriesForProofBucket, ruleStatusEntriesForSemanticAdapter, ruleStatusEntriesForStatus, ruleStatusEntryForId, ruleStatusManifest, ruleStatusSemanticSummaries, ruleStatusSemanticSummaryForId, semanticFact, semanticFactKindContractsForAdapterId, semanticFactKindContractsForConfidence, semanticFactKindContractsForEmission, semanticFactKindContractsForRule, semanticFactToJsonLine, undercheckedPredicateInventory, verifySession } from "@joedeleeuw/antidrift/policy";\n' +
      'import { SEMANTIC_ADAPTERS, SEMANTIC_ADAPTER_CONTRACTS, SEMANTIC_ADAPTER_CONTRACT_LIST, SEMANTIC_ADAPTER_MANIFEST, asyncControlFlow as adapterAsyncControlFlow, authBoundary as adapterAuthBoundary, broadInput as adapterBroadInput, parseInput as adapterParseInput, reactState as adapterReactState, schemaProvenance as adapterSchemaProvenance, semanticAdapterContractsForFactAdapterId, semanticAdapterContractsForFactKind, semanticAdapterContractsForProofBucket, semanticAdapterContractsForRule, semanticAdapterManifestForAdapterId, semanticAdapterManifestForFactAdapterId, semanticAdapterManifestForFactKind, semanticAdapterManifestForProofBucket, semanticAdapterManifestForRule, sql as adapterSql, tupleShape as adapterTupleShape, typeOwner as adapterTypeOwner } from "@joedeleeuw/antidrift/semantic-adapters";\n' +
      'import { REQUEST_PARAM_ROOTS, callExpressionName, createAuthBoundaryTracker, isAuthzCall, isRequestParamsAccess } from "@joedeleeuw/antidrift/semantic-adapters/auth-boundary";\n' +
      'import { ASYNC_ARRAY_METHODS_NEVER_AWAIT, ASYNC_ARRAY_METHODS_REQUIRE_COLLECTION, PROMISE_COMBINATOR_METHODS, asyncArrayCallbackClassification, asyncCallbackArgument, findVariable, getDeclaredVariable, isDirectlyWrappedInPromiseCombinator, isPromiseCombinator, isReturnedExpression, markAwaitedPendingMaps, markReturnedPendingMaps, promiseCombinatorVariables, queuePendingAsyncMap } from "@joedeleeuw/antidrift/semantic-adapters/async-control-flow";\n' +
      'import { BROAD_INPUT_ARRAY_TRANSFORM_METHODS, assignmentTarget, callUsesPredicateParam, checkedTargetProperties, collectBindingIdentifiers, collectBindingNames, collectObjectPatternBindingNames, countShapeProbesIn, destructuredTargetPropertyAliases, directAliasName, functionParameterByName, hasBroadObjectEntriesValue, hasParamRoot, hasValidatorDelegation, isAppeasementCastSourceType, isAppeasementCastTargetType, isAppeasementContractCast, isBindingIdentifier, isBroadPredicateInputType, isBroadShapeProbeInputType, isNamedTypeReference, isNullishLiteral, isObjectEntriesCall, isPredicateObjectContract, isTypeofObjectProbe, memberExpressionPropertyName, memberExpressionRootName, objectEntriesCallbackProbe, objectEntriesValueBindings, objectHasOwnPropertyName, predicateValueNames, requiredTypeProps, staticPropertyName, typePredicateParts, unwrapExpression, walkNode } from "@joedeleeuw/antidrift/semantic-adapters/broad-input";\n' +
      'import { hasLocalStringBoundary, isJsonParseCall, jsonParseArgument } from "@joedeleeuw/antidrift/semantic-adapters/parse-input";\n' +
      'import { classifyWriteValue, createReactStateTracker, frameStatePayload, lifecycleProof } from "@joedeleeuw/antidrift/semantic-adapters/react-state";\n' +
      'import { ZOD_PARSE_METHODS, ZOD_THROW_ASSERTION_MATCHERS, isAwaitedCallInitializer, isCallResultExpression, isThrowAssertionCallbackParse, isZodParseExpression, parsedCallResultMatchesSchemaOutput, recordParsedConst, zodParseCallParts } from "@joedeleeuw/antidrift/semantic-adapters/schema-provenance";\n' +
      'import { isSqlDirectionTokenValue, isSqlIdentifierContext, isSqlIdentifierTokenValue, isSqlInterpolationContext, normalizedSqlContext, removeTrailingSqlQuote, safeIdentifierMemberSpecs, valuesAreSqlDirections, valuesAreSqlIdentifiers } from "@joedeleeuw/antidrift/semantic-adapters/sql";\n' +
      'import { hasNullablePositionalTuple, nullableTupleSlots, tupleElementIsNullishSlot, tupleElementIsOptional, tupleElementResolvesToNullish, tupleElementTypeNode, typeIncludesNullish, typeNodeIncludesDirectNullish } from "@joedeleeuw/antidrift/semantic-adapters/tuple-shape";\n' +
      'import { MIN_PROPS, canonicalStatusLiteralOwner, collectAcceptedPackageCanonicalTypes, collectCanonicalTypes, collectDomainCanonicalTypes, collectGeneratedCanonicalTypes, isObjectType, isStatusContextName, isStatusLiteralContext, normalizedContextName, nodeKeyName, resolvesToDomainCanonicalType, resolvesToGeneratedType, resolvesToInstalledType, typeProps } from "@joedeleeuw/antidrift/semantic-adapters/type-owner";\n' +
      "\n" +
      "const exportsToCheck = {\n" +
      "  createConfig,\n" +
      "  eslintPlugin,\n" +
      "  loadPolicy,\n" +
      "  loadRegistriesSync,\n" +
      "  renderPolicyArtifacts,\n" +
      "  brand,\n" +
      "  plugin,\n" +
      "  createConfigFromSubpath,\n" +
      "  checkGenerated,\n" +
      "  checkRegistries,\n" +
      "  checkRuleSurface,\n" +
      "  defensiveShapeInventory,\n" +
      "  eslintJsonToSonar,\n" +
      "  externalCorpus,\n" +
      "  generate,\n" +
      "  classifyReactStateFact,\n" +
      "  classifySqlParserServiceDelta,\n" +
      "  SEMANTIC_ADAPTERS,\n" +
      "  SEMANTIC_ADAPTER_CONTRACTS,\n" +
      "  SEMANTIC_ADAPTER_CONTRACT_LIST,\n" +
      "  SEMANTIC_ADAPTER_MANIFEST,\n" +
      "  adapterAsyncControlFlow,\n" +
      "  adapterAuthBoundary,\n" +
      "  adapterBroadInput,\n" +
      "  adapterParseInput,\n" +
      "  adapterReactState,\n" +
      "  adapterSchemaProvenance,\n" +
      "  adapterSql,\n" +
      "  adapterTupleShape,\n" +
      "  adapterTypeOwner,\n" +
      "  REQUEST_PARAM_ROOTS,\n" +
      "  callExpressionName,\n" +
      "  createAuthBoundaryTracker,\n" +
      "  isAuthzCall,\n" +
      "  isRequestParamsAccess,\n" +
      "  ASYNC_ARRAY_METHODS_NEVER_AWAIT,\n" +
      "  ASYNC_ARRAY_METHODS_REQUIRE_COLLECTION,\n" +
      "  PROMISE_COMBINATOR_METHODS,\n" +
      "  asyncArrayCallbackClassification,\n" +
      "  asyncCallbackArgument,\n" +
      "  findVariable,\n" +
      "  getDeclaredVariable,\n" +
      "  isDirectlyWrappedInPromiseCombinator,\n" +
      "  isPromiseCombinator,\n" +
      "  isReturnedExpression,\n" +
      "  markAwaitedPendingMaps,\n" +
      "  markReturnedPendingMaps,\n" +
      "  promiseCombinatorVariables,\n" +
      "  queuePendingAsyncMap,\n" +
      "  BROAD_INPUT_ARRAY_TRANSFORM_METHODS,\n" +
      "  unwrapExpression,\n" +
      "  assignmentTarget,\n" +
      "  collectBindingIdentifiers,\n" +
      "  collectBindingNames,\n" +
      "  collectObjectPatternBindingNames,\n" +
      "  countShapeProbesIn,\n" +
      "  destructuredTargetPropertyAliases,\n" +
      "  hasBroadObjectEntriesValue,\n" +
      "  hasParamRoot,\n" +
      "  isNullishLiteral,\n" +
      "  isObjectEntriesCall,\n" +
      "  isTypeofObjectProbe,\n" +
      "  isBroadShapeProbeInputType,\n" +
      "  memberExpressionPropertyName,\n" +
      "  memberExpressionRootName,\n" +
      "  objectEntriesCallbackProbe,\n" +
      "  objectEntriesValueBindings,\n" +
      "  objectHasOwnPropertyName,\n" +
      "  callUsesPredicateParam,\n" +
      "  checkedTargetProperties,\n" +
      "  directAliasName,\n" +
      "  functionParameterByName,\n" +
      "  hasValidatorDelegation,\n" +
      "  isAppeasementCastSourceType,\n" +
      "  isAppeasementCastTargetType,\n" +
      "  isAppeasementContractCast,\n" +
      "  isBindingIdentifier,\n" +
      "  isBroadPredicateInputType,\n" +
      "  isPredicateObjectContract,\n" +
      "  isNamedTypeReference,\n" +
      "  hasLocalStringBoundary,\n" +
      "  isJsonParseCall,\n" +
      "  jsonParseArgument,\n" +
      "  predicateValueNames,\n" +
      "  requiredTypeProps,\n" +
      "  staticPropertyName,\n" +
      "  typePredicateParts,\n" +
      "  walkNode,\n" +
      "  classifyWriteValue,\n" +
      "  createReactStateTracker,\n" +
      "  frameStatePayload,\n" +
      "  lifecycleProof,\n" +
      "  ZOD_PARSE_METHODS,\n" +
      "  ZOD_THROW_ASSERTION_MATCHERS,\n" +
      "  isAwaitedCallInitializer,\n" +
      "  isCallResultExpression,\n" +
      "  isThrowAssertionCallbackParse,\n" +
      "  isZodParseExpression,\n" +
      "  parsedCallResultMatchesSchemaOutput,\n" +
      "  recordParsedConst,\n" +
      "  zodParseCallParts,\n" +
      "  isSqlDirectionTokenValue,\n" +
      "  isSqlIdentifierContext,\n" +
      "  isSqlIdentifierTokenValue,\n" +
      "  isSqlInterpolationContext,\n" +
      "  normalizedSqlContext,\n" +
      "  removeTrailingSqlQuote,\n" +
      "  safeIdentifierMemberSpecs,\n" +
      "  valuesAreSqlDirections,\n" +
      "  valuesAreSqlIdentifiers,\n" +
      "  hasNullablePositionalTuple,\n" +
      "  nullableTupleSlots,\n" +
      "  tupleElementIsNullishSlot,\n" +
      "  tupleElementIsOptional,\n" +
      "  tupleElementResolvesToNullish,\n" +
      "  tupleElementTypeNode,\n" +
      "  typeIncludesNullish,\n" +
      "  typeNodeIncludesDirectNullish,\n" +
      "  MIN_PROPS,\n" +
      "  canonicalStatusLiteralOwner,\n" +
      "  collectAcceptedPackageCanonicalTypes,\n" +
      "  collectCanonicalTypes,\n" +
      "  collectDomainCanonicalTypes,\n" +
      "  collectGeneratedCanonicalTypes,\n" +
      "  isObjectType,\n" +
      "  isStatusContextName,\n" +
      "  isStatusLiteralContext,\n" +
      "  normalizedContextName,\n" +
      "  nodeKeyName,\n" +
      "  resolvesToDomainCanonicalType,\n" +
      "  resolvesToGeneratedType,\n" +
      "  resolvesToInstalledType,\n" +
      "  typeProps,\n" +
      "  loadPolicyFromPolicy,\n" +
      "  loadRegistriesFromPolicy,\n" +
      "  loadRuleStatusRegistrySync,\n" +
      "  renderPolicyArtifactsFromPolicy,\n" +
      "  reactStateInventory,\n" +
      "  repoCorpus,\n" +
      "  ruleStatusEntriesForKind,\n" +
      "  ruleStatusEntriesForProofBucket,\n" +
      "  ruleStatusEntriesForSemanticAdapter,\n" +
      "  ruleStatusEntriesForStatus,\n" +
      "  ruleStatusEntryForId,\n" +
      "  ruleStatusManifest,\n" +
      "  ruleStatusSemanticSummaries,\n" +
      "  ruleStatusSemanticSummaryForId,\n" +
      "  undercheckedPredicateInventory,\n" +
      "  declarationCloneInventory,\n" +
      "  SEMANTIC_FACT_KINDS,\n" +
      "  SEMANTIC_FACT_KIND_CONTRACT_LIST,\n" +
      "  SEMANTIC_FACT_SCHEMA_VERSION,\n" +
      "  semanticFactKindContractsForAdapterId,\n" +
      "  semanticFactKindContractsForConfidence,\n" +
      "  semanticFactKindContractsForEmission,\n" +
      "  semanticFactKindContractsForRule,\n" +
      "  semanticAdapterManifestForAdapterId,\n" +
      "  semanticAdapterManifestForFactAdapterId,\n" +
      "  semanticAdapterManifestForFactKind,\n" +
      "  semanticAdapterManifestForProofBucket,\n" +
      "  semanticAdapterManifestForRule,\n" +
      "  createJsonlFactSink,\n" +
      "  createMemoryFactSink,\n" +
      "  semanticFact,\n" +
      "  semanticFactToJsonLine,\n" +
      "  verifySession,\n" +
      "};\n" +
      "\n" +
      'const jsonParseCall = { type: "CallExpression", callee: { type: "MemberExpression", object: { type: "Identifier", name: "JSON" }, property: { type: "Identifier", name: "parse" } }, arguments: [{ type: "Identifier", name: "raw" }] };\n' +
      "\n" +
      "for (const [name, value] of Object.entries(exportsToCheck)) {\n" +
      '  if (typeof value !== "function" && typeof value !== "object" && typeof value !== "number") {\n' +
      "    throw new Error(`Missing runtime export: ${name}`);\n" +
      "  }\n" +
      "}\n" +
      "\n" +
      'if (!SEMANTIC_FACT_KINDS.structuralMatch.payloadFields.includes("ownerType")) {\n' +
      '  throw new Error("Missing structuralMatch semantic fact contract");\n' +
      "}\n" +
      "\n" +
      'if (!SEMANTIC_FACT_KINDS.structuralMatch.association.includes("owner types") || !SEMANTIC_FACT_KINDS.structuralMatch.noSinkBehavior.includes("proposal")) {\n' +
      '  throw new Error("Missing semantic fact association metadata");\n' +
      "}\n" +
      "\n" +
      'if (SEMANTIC_FACT_KIND_CONTRACT_LIST.find((entry) => entry.factKind === "resourceLifecycleProof")?.adapterId !== "react-state" || semanticFactKindContractsForAdapterId("react-state").filter((entry) => entry.rules.includes("antidrift/no-handrolled-resource-lifecycle-cells")).length !== 2 || semanticFactKindContractsForRule("antidrift/no-handrolled-resource-lifecycle-cells").length !== 2 || semanticFactKindContractsForAdapterId("not-real").length !== 0) {\n' +
      '  throw new Error("Missing semantic fact contract lookup behavior");\n' +
      "}\n" +
      "\n" +
      "const runtimeRuleStatus = ruleStatusManifest(loadRuleStatusRegistrySync('policy'));\n" +
      'if (ruleStatusEntryForId("antidrift/no-structural-type-fork", runtimeRuleStatus)?.kind !== "active" || ruleStatusEntriesForKind("research", runtimeRuleStatus)[0]?.id !== "ecosystem/import-cycle" || ruleStatusEntriesForProofBucket("authority-index-ownership", runtimeRuleStatus)[0]?.id !== "antidrift/no-structural-type-fork" || !ruleStatusEntriesForProofBucket("local-ast-source-shape", runtimeRuleStatus).some((entry) => entry.id === "antidrift/no-async-array-method") || !ruleStatusEntriesForProofBucket("local-ast-source-shape", runtimeRuleStatus).some((entry) => entry.id === "antidrift/no-nullable-positional-tuple") || !ruleStatusEntriesForProofBucket("local-ast-source-shape", runtimeRuleStatus).some((entry) => entry.id === "antidrift/no-raw-fetch-in-component") || ruleStatusEntriesForSemanticAdapter("async-control-flow", runtimeRuleStatus)[0]?.id !== "antidrift/no-async-array-method" || ruleStatusEntriesForSemanticAdapter("type-owner", runtimeRuleStatus)[0]?.id !== "antidrift/no-structural-type-fork" || ruleStatusEntriesForStatus("retired", runtimeRuleStatus)[0]?.id !== "antidrift/no-status-triplet-state") {\n' +
      '  throw new Error("Missing rule status registry behavior");\n' +
      "}\n" +
      "\n" +
      'if (ruleStatusSemanticSummaryForId("antidrift/no-async-array-method", runtimeRuleStatus)?.semanticAdapters[0]?.id !== "async-control-flow" || ruleStatusSemanticSummaryForId("antidrift/no-handrolled-resource-lifecycle-cells", runtimeRuleStatus)?.semanticAdapters[0]?.id !== "react-state" || ruleStatusSemanticSummaryForId("antidrift/no-handrolled-resource-lifecycle-cells", runtimeRuleStatus)?.semanticFactContracts.map((entry) => entry.factKind).join(",") !== "broadSetterCoMutation,resourceLifecycleProof,sourceMemberStateShardCandidate" || ruleStatusSemanticSummaryForId("antidrift/no-raw-fetch-in-component", runtimeRuleStatus)?.proofBuckets.join(",") !== "local-ast-source-shape" || ruleStatusSemanticSummaryForId("antidrift/no-nullable-positional-tuple", runtimeRuleStatus)?.semanticAdapters[0]?.id !== "tuple-shape" || ruleStatusSemanticSummaries(runtimeRuleStatus).length !== 8) {\n' +
      '  throw new Error("Missing joined rule semantic summary behavior");\n' +
      "}\n" +
      "\n" +
      'if (semanticFactKindContractsForEmission("inventory-only").map((entry) => entry.factKind).join(",") !== "broadSetterCoMutation,sourceMemberStateShardCandidate,changeContractConformance" || semanticFactKindContractsForEmission("blocking-diagnostic").length !== 2 || semanticFactKindContractsForConfidence("deterministic-enforcement").length !== 2 || semanticFactKindContractsForEmission("not-real").length !== 0) {\n' +
      '  throw new Error("Missing semantic fact contract emission/confidence lookup behavior");\n' +
      "}\n" +
      "\n" +
      'if (classifyWriteValue({ type: "Literal", value: false }, { awaitedNames: new Set(), catchParams: [] }) !== "falseConst") {\n' +
      '  throw new Error("Missing react-state semantic adapter behavior");\n' +
      "}\n" +
      "\n" +
      "if (!isJsonParseCall(jsonParseCall) || jsonParseArgument(jsonParseCall) !== jsonParseCall.arguments[0] || hasLocalStringBoundary(jsonParseCall, jsonParseCall.arguments[0])) {\n" +
      '  throw new Error("Missing parse-input semantic adapter behavior");\n' +
      "}\n" +
      "\n" +
      'const runtimeAsyncCallback = { type: "ArrowFunctionExpression", async: true };\n' +
      'const runtimeAsyncMapCall = { type: "CallExpression", callee: { type: "MemberExpression", object: { type: "Identifier", name: "items" }, property: { type: "Identifier", name: "map" } }, arguments: [runtimeAsyncCallback] };\n' +
      'const runtimeVariable = { name: "mapped" };\n' +
      'const runtimeDeclarator = { type: "VariableDeclarator", id: { type: "Identifier", name: "mapped" }, init: runtimeAsyncMapCall };\n' +
      "runtimeAsyncMapCall.parent = runtimeDeclarator;\n" +
      'const runtimeSourceCode = { scopeManager: { getDeclaredVariables(node) { return node === runtimeDeclarator ? [runtimeVariable] : []; } }, getScope() { return { set: new Map([["mapped", runtimeVariable]]), upper: null }; } };\n' +
      "const runtimePendingAsyncMaps = [];\n" +
      'const runtimePromiseAll = { type: "CallExpression", callee: { type: "MemberExpression", object: { type: "Identifier", name: "Promise" }, property: { type: "Identifier", name: "all" } }, arguments: [{ type: "Identifier", name: "mapped" }] };\n' +
      'const runtimeDirectMapCall = { type: "CallExpression", callee: { type: "MemberExpression", object: { type: "Identifier", name: "items" }, property: { type: "Identifier", name: "map" } }, arguments: [runtimeAsyncCallback] };\n' +
      'const runtimeDirectPromiseAll = { type: "CallExpression", callee: { type: "MemberExpression", object: { type: "Identifier", name: "Promise" }, property: { type: "Identifier", name: "all" } }, arguments: [runtimeDirectMapCall] };\n' +
      "runtimeDirectMapCall.parent = runtimeDirectPromiseAll;\n" +
      'if (!ASYNC_ARRAY_METHODS_NEVER_AWAIT.has("forEach") || !ASYNC_ARRAY_METHODS_REQUIRE_COLLECTION.has("map") || !PROMISE_COMBINATOR_METHODS.has("all") || asyncCallbackArgument(runtimeAsyncMapCall) !== runtimeAsyncCallback || asyncArrayCallbackClassification(runtimeAsyncMapCall)?.kind !== "requires-collection" || !queuePendingAsyncMap(runtimeSourceCode, runtimeAsyncMapCall, runtimeAsyncCallback, "map", runtimePendingAsyncMaps) || getDeclaredVariable(runtimeSourceCode, runtimeDeclarator) !== runtimeVariable || findVariable(runtimeSourceCode, { type: "Identifier", name: "mapped" }) !== runtimeVariable || promiseCombinatorVariables(runtimeSourceCode, runtimePromiseAll)[0] !== runtimeVariable || !isPromiseCombinator(runtimePromiseAll.callee) || !isDirectlyWrappedInPromiseCombinator(runtimeDirectMapCall)) {\n' +
      '  throw new Error("Missing async-control-flow semantic adapter behavior");\n' +
      "}\n" +
      "markAwaitedPendingMaps(runtimeSourceCode, runtimePromiseAll, runtimePendingAsyncMaps);\n" +
      "if (!runtimePendingAsyncMaps[0]?.awaited) {\n" +
      '  throw new Error("Missing async-control-flow Promise combinator marking behavior");\n' +
      "}\n" +
      "\n" +
      "runtimePendingAsyncMaps[0].returned = false;\n" +
      'markReturnedPendingMaps(runtimeSourceCode, { type: "ReturnStatement", argument: { type: "Identifier", name: "mapped" } }, runtimePendingAsyncMaps);\n' +
      "if (!runtimePendingAsyncMaps[0]?.returned) {\n" +
      '  throw new Error("Missing async-control-flow returned collection marking behavior");\n' +
      "}\n" +
      "\n" +
      'const runtimeReturnedExpression = { type: "CallExpression" };\n' +
      'runtimeReturnedExpression.parent = { type: "ReturnStatement", argument: runtimeReturnedExpression };\n' +
      'if (!isReturnedExpression(runtimeReturnedExpression) || isReturnedExpression({ parent: { type: "CallExpression" } })) {\n' +
      '  throw new Error("Missing returned async expression adapter behavior");\n' +
      "}\n" +
      "\n" +
      "if (SEMANTIC_ADAPTERS.asyncControlFlow !== adapterAsyncControlFlow || SEMANTIC_ADAPTERS.authBoundary !== adapterAuthBoundary || SEMANTIC_ADAPTERS.broadInput !== adapterBroadInput || SEMANTIC_ADAPTERS.parseInput !== adapterParseInput || SEMANTIC_ADAPTERS.reactState !== adapterReactState || SEMANTIC_ADAPTERS.schemaProvenance !== adapterSchemaProvenance || SEMANTIC_ADAPTERS.sql !== adapterSql || SEMANTIC_ADAPTERS.tupleShape !== adapterTupleShape || SEMANTIC_ADAPTERS.typeOwner !== adapterTypeOwner) {\n" +
      '  throw new Error("Missing semantic-adapters aggregate registry behavior");\n' +
      "}\n" +
      "\n" +
      'if (SEMANTIC_ADAPTER_CONTRACT_LIST.length !== 9 || !SEMANTIC_ADAPTER_CONTRACTS.asyncControlFlow.rules.includes("antidrift/no-async-array-method") || SEMANTIC_ADAPTER_CONTRACTS.parseInput.subpath !== "@joedeleeuw/antidrift/semantic-adapters/parse-input" || !SEMANTIC_ADAPTER_CONTRACTS.parseInput.rules.includes("antidrift/no-unsafe-deserialize") || !SEMANTIC_ADAPTER_CONTRACTS.broadInput.rules.includes("antidrift/no-appeasement-cast") || SEMANTIC_ADAPTER_CONTRACTS.sql.subpath !== "@joedeleeuw/antidrift/semantic-adapters/sql" || !SEMANTIC_ADAPTER_CONTRACTS.sql.proofBuckets.includes("semantic-source-type-provenance") || !SEMANTIC_ADAPTER_CONTRACTS.reactState.semanticFactAdapterIds.includes("react-state") || !SEMANTIC_ADAPTER_CONTRACTS.reactState.semanticFactKinds.includes("resourceLifecycleProof") || !SEMANTIC_ADAPTER_CONTRACTS.tupleShape.rules.includes("antidrift/no-nullable-positional-tuple") || !SEMANTIC_ADAPTER_CONTRACTS.typeOwner.semanticFactAdapterIds.includes("typescript-eslint/type-owner") || !SEMANTIC_ADAPTER_CONTRACTS.typeOwner.semanticFactKinds.includes("structuralMatch") || !SEMANTIC_ADAPTER_CONTRACTS.typeOwner.rules.includes("antidrift/no-structural-type-fork") || !SEMANTIC_ADAPTER_CONTRACTS.typeOwner.rules.includes("antidrift/no-status-literal-in-type") || !SEMANTIC_ADAPTER_CONTRACTS.reactState.associations.some((association) => association.includes("lifecycle"))) {\n' +
      '  throw new Error("Missing semantic adapter contract metadata");\n' +
      "}\n" +
      "\n" +
      'if (SEMANTIC_ADAPTER_MANIFEST.length !== 9 || semanticAdapterManifestForAdapterId("async-control-flow")?.rules[0] !== "antidrift/no-async-array-method" || semanticAdapterManifestForAdapterId("parse-input")?.rules[0] !== "antidrift/no-unsafe-deserialize" || semanticAdapterManifestForAdapterId("react-state")?.semanticFactContracts.map((entry) => entry.factKind).join(",") !== "broadSetterCoMutation,resourceLifecycleProof,sourceMemberStateShardCandidate" || semanticAdapterManifestForAdapterId("tuple-shape")?.rules[0] !== "antidrift/no-nullable-positional-tuple" || semanticAdapterManifestForAdapterId("not-real") !== null) {\n' +
      '  throw new Error("Missing semantic adapter manifest behavior");\n' +
      "}\n" +
      "\n" +
      'if (semanticAdapterManifestForRule("antidrift/no-async-array-method")[0]?.id !== "async-control-flow" || semanticAdapterManifestForRule("antidrift/no-handrolled-resource-lifecycle-cells")[0]?.id !== "react-state" || semanticAdapterManifestForRule("antidrift/no-appeasement-cast")[0]?.id !== "broad-input" || semanticAdapterManifestForRule("antidrift/no-unsafe-deserialize")[0]?.id !== "parse-input" || semanticAdapterManifestForRule("antidrift/no-nullable-positional-tuple")[0]?.id !== "tuple-shape" || semanticAdapterManifestForRule("antidrift/no-status-literal-in-type")[0]?.id !== "type-owner" || semanticAdapterManifestForFactAdapterId("typescript-eslint/type-owner")[0]?.id !== "type-owner" || semanticAdapterManifestForFactKind("structuralMatch")[0]?.id !== "type-owner" || semanticAdapterManifestForProofBucket("authority-index-ownership")[0]?.id !== "type-owner" || semanticAdapterManifestForRule("antidrift/not-real").length !== 0) {\n' +
      '  throw new Error("Missing semantic adapter manifest lookup behavior");\n' +
      "}\n" +
      "\n" +
      'if (semanticAdapterContractsForRule("antidrift/no-async-array-method")[0]?.id !== "async-control-flow" || semanticAdapterContractsForRule("antidrift/no-handrolled-resource-lifecycle-cells")[0]?.id !== "react-state" || semanticAdapterContractsForRule("antidrift/no-appeasement-cast")[0]?.id !== "broad-input" || semanticAdapterContractsForRule("antidrift/no-unsafe-deserialize")[0]?.id !== "parse-input" || semanticAdapterContractsForRule("antidrift/no-nullable-positional-tuple")[0]?.id !== "tuple-shape" || semanticAdapterContractsForRule("antidrift/no-status-literal-in-type")[0]?.id !== "type-owner" || semanticAdapterContractsForFactAdapterId("typescript-eslint/type-owner")[0]?.id !== "type-owner" || semanticAdapterContractsForFactKind("structuralMatch")[0]?.id !== "type-owner" || semanticAdapterContractsForProofBucket("authority-index-ownership")[0]?.id !== "type-owner" || semanticAdapterContractsForRule("antidrift/not-real").length !== 0) {\n' +
      '  throw new Error("Missing semantic adapter contract lookup behavior");\n' +
      "}\n" +
      "\n" +
      'if (!REQUEST_PARAM_ROOTS.includes("req") || callExpressionName({ type: "Identifier", name: "authorize" }) !== "authorize" || !isAuthzCall({ type: "Identifier", name: "authorize" }, ["authorize"]) || !isRequestParamsAccess({ type: "MemberExpression", object: { type: "Identifier", name: "req" }, property: { type: "Identifier", name: "params" } })) {\n' +
      '  throw new Error("Missing auth-boundary semantic adapter behavior");\n' +
      "}\n" +
      "\n" +
      'if (!BROAD_INPUT_ARRAY_TRANSFORM_METHODS.has("map") || memberExpressionRootName({ type: "MemberExpression", object: { type: "Identifier", name: "value" }, property: { type: "Identifier", name: "field" } }) !== "value" || !hasParamRoot({ type: "MemberExpression", object: { type: "Identifier", name: "value" }, property: { type: "Identifier", name: "field" } }, new Set(["value"])) || !isNamedTypeReference({ type: "TSTypeReference" }) || !isNullishLiteral({ type: "Literal", value: null }) || !isObjectEntriesCall({ type: "CallExpression", callee: { type: "MemberExpression", object: { type: "Identifier", name: "Object" }, property: { type: "Identifier", name: "entries" } } })) {\n' +
      '  throw new Error("Missing broad-input semantic adapter behavior");\n' +
      "}\n" +
      "\n" +
      'if (!ZOD_PARSE_METHODS.has("parse") || !ZOD_THROW_ASSERTION_MATCHERS.has("toThrow") || !isAwaitedCallInitializer({ type: "AwaitExpression", argument: { type: "CallExpression" } }) || !isCallResultExpression({ type: "CallExpression" })) {\n' +
      '  throw new Error("Missing schema-provenance semantic adapter behavior");\n' +
      "}\n" +
      "\n" +
      'if (!isSqlIdentifierTokenValue("public.users") || !isSqlInterpolationContext("SEL" + "ECT * FROM ", "")) {\n' +
      '  throw new Error("Missing SQL semantic adapter behavior");\n' +
      "}\n" +
      "\n" +
      'const runtimeNullableTuple = { type: "TSTupleType", elementTypes: [{ type: "TSUnionType", types: [{ type: "TSStringKeyword" }, { type: "TSNullKeyword" }] }, { type: "TSOptionalType", typeAnnotation: { type: "TSNumberKeyword" } }] };\n' +
      'if (!hasNullablePositionalTuple(runtimeNullableTuple) || nullableTupleSlots(runtimeNullableTuple).length !== 2 || !tupleElementIsNullishSlot(runtimeNullableTuple.elementTypes[0]) || !tupleElementIsOptional(runtimeNullableTuple.elementTypes[1]) || tupleElementResolvesToNullish(runtimeNullableTuple.elementTypes[0]) || tupleElementTypeNode(runtimeNullableTuple.elementTypes[1]) !== runtimeNullableTuple.elementTypes[1].typeAnnotation || typeIncludesNullish(null) || !typeNodeIncludesDirectNullish(runtimeNullableTuple.elementTypes[0])) {\n' +
      '  throw new Error("Missing tuple-shape semantic adapter behavior");\n' +
      "}\n" +
      "\n" +
      'const runtimeStatusLiteral = { type: "TSLiteralType", literal: { value: "active" }, parent: { type: "TSTypeAliasDeclaration", id: { name: "UserStatus" } } };\n' +
      'if (MIN_PROPS !== 4 || canonicalStatusLiteralOwner(runtimeStatusLiteral, { UserStatus: { owner: "packages/domain/src/user.ts", values: ["active"] } })?.owner !== "packages/domain/src/user.ts" || !isStatusContextName("user_status", "UserStatus") || !isStatusLiteralContext(runtimeStatusLiteral, "UserStatus") || normalizedContextName("User Status") !== "userstatus" || nodeKeyName({ type: "Identifier", name: "status" }) !== "status") {\n' +
      '  throw new Error("Missing type-owner semantic adapter contract");\n' +
      "}\n",
  );

  console.log("3/7  installing the tarball into the consumer ...");
  run("pnpm", ["install", "--prefer-offline", "--config.confirmModulesPurge=false"], work);

  console.log("4/7  linting consumer files through shipped and opt-in configs ...");
  const semanticFactFile = join(work, "semantic-facts.jsonl");
  rmSync(semanticFactFile, { force: true });

  function lint(relFile, config = "eslint.config.mjs") {
    try {
      return runJson(
        "pnpm",
        ["exec", "eslint", relFile, "--format", "json", "--config", config],
        work,
      );
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "stdout" in error &&
        typeof error.stdout === "string"
      ) {
        return JSON.parse(error.stdout);
      }
      throw error;
    }
  }

  const RULE = "antidrift/no-structural-type-fork";
  const defaultDriftRules = lint("packages/app/src/drift.ts").flatMap((r) =>
    r.messages.map((m) => m.ruleId),
  );
  if (defaultDriftRules.includes(RULE)) {
    fail(
      `default config must keep ${RULE} off, got: ${JSON.stringify(defaultDriftRules)}`,
    );
  }

  rmSync(semanticFactFile, { force: true });
  const structuralConfig = "eslint.structural.config.mjs";
  const driftRules = lint("packages/app/src/drift.ts", structuralConfig).flatMap(
    (r) => r.messages.map((m) => m.ruleId),
  );
  const cleanRules = lint("packages/app/src/clean.ts", structuralConfig).flatMap(
    (r) => r.messages.map((m) => m.ruleId),
  );
  const packageCopyRules = lint(
    "packages/app/src/package-copy.ts",
    structuralConfig,
  ).flatMap((r) => r.messages.map((m) => m.ruleId));

  if (!driftRules.includes(RULE)) {
    fail(
      `opt-in config drift.ts should have reported ${RULE}, got: ${JSON.stringify(driftRules)}`,
    );
  }
  if (cleanRules.includes(RULE)) {
    fail(
      `clean.ts (legitimate firebase import) must NOT report ${RULE}, got: ${JSON.stringify(cleanRules)}`,
    );
  }
  if (packageCopyRules.includes(RULE)) {
    fail(
      `package-copy.ts (unaccepted package authority) must NOT report ${RULE}, got: ${JSON.stringify(packageCopyRules)}`,
    );
  }

  const ASYNC_RULE = "antidrift/no-async-array-method";
  const asyncDefaultConfig = "eslint.async-array.config.mjs";
  const asyncCollectionConfig = "eslint.async-array-collection.config.mjs";
  const asyncForEachRules = lint(
    "packages/app/src/async-foreach-drift.ts",
    asyncDefaultConfig,
  ).flatMap((r) => r.messages.map((m) => m.ruleId));
  const asyncMapDefaultRules = lint(
    "packages/app/src/async-map-collection-drift.ts",
    asyncDefaultConfig,
  ).flatMap((r) => r.messages.map((m) => m.ruleId));
  const asyncMapCollectionRules = lint(
    "packages/app/src/async-map-collection-drift.ts",
    asyncCollectionConfig,
  ).flatMap((r) => r.messages.map((m) => m.ruleId));
  const asyncMapReturnRules = lint(
    "packages/app/src/async-map-return-clean.ts",
    asyncCollectionConfig,
  ).flatMap((r) => r.messages.map((m) => m.ruleId));

  if (!asyncForEachRules.includes(ASYNC_RULE)) {
    fail(
      `explicit async-array config should report forEach drift, got: ${JSON.stringify(asyncForEachRules)}`,
    );
  }
  if (asyncMapDefaultRules.includes(ASYNC_RULE)) {
    fail(
      `default async-array branch must not report map collection flow, got: ${JSON.stringify(asyncMapDefaultRules)}`,
    );
  }
  if (!asyncMapCollectionRules.includes(ASYNC_RULE)) {
    fail(
      `opt-in async-array collection branch should report unjoined map flow, got: ${JSON.stringify(asyncMapCollectionRules)}`,
    );
  }
  if (asyncMapReturnRules.includes(ASYNC_RULE)) {
    fail(
      `opt-in async-array collection branch must not report returned promise arrays, got: ${JSON.stringify(asyncMapReturnRules)}`,
    );
  }

  const semanticFacts = readFileSync(semanticFactFile, "utf8")
    .trim()
    .split(/\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const generatedStructuralFact = semanticFacts.find(
    (fact) =>
      fact.factKind === "structuralMatch" &&
      fact.ruleId === RULE &&
      fact.confidence === "deterministic-enforcement" &&
      fact.payload?.authorityState === "accepted" &&
      fact.payload?.ownerType?.authority === "generated-source" &&
      fact.filePath === "packages/app/src/drift.ts",
  );

  if (!generatedStructuralFact) {
    fail(
      `opt-in config drift.ts should have emitted a generated-source structuralMatch fact, got: ${JSON.stringify(semanticFacts)}`,
    );
  }

  console.log(
    "5/7  reading the shipped semantic adapter manifest from the CLI ...",
  );
  const semanticManifest = runJson(
    "pnpm",
    ["exec", "antidrift", "semantic-manifest"],
    work,
  );
  const reactStateManifest = semanticManifest.find(
    (entry) => entry.id === "react-state",
  );
  const typeOwnerManifest = semanticManifest.find(
    (entry) => entry.id === "type-owner",
  );

  if (
    reactStateManifest?.semanticFactContracts
      ?.map((entry) => entry.factKind)
      .join(",") !== "broadSetterCoMutation,resourceLifecycleProof,sourceMemberStateShardCandidate" ||
    !typeOwnerManifest?.proofBuckets?.includes("authority-index-ownership")
  ) {
    fail(
      `semantic-manifest should expose composed adapter/fact metadata, got: ${JSON.stringify(semanticManifest)}`,
    );
  }
  const reactStateSemanticManifest = runJson(
    "pnpm",
    [
      "exec",
      "antidrift",
      "semantic-manifest",
      "--rule",
      "antidrift/no-handrolled-resource-lifecycle-cells",
    ],
    work,
  );
  const asyncControlSemanticManifest = runJson(
    "pnpm",
    [
      "exec",
      "antidrift",
      "semantic-manifest",
      "--rule",
      "antidrift/no-async-array-method",
    ],
    work,
  );
  const tupleShapeSemanticManifest = runJson(
    "pnpm",
    [
      "exec",
      "antidrift",
      "semantic-manifest",
      "--rule",
      "antidrift/no-nullable-positional-tuple",
    ],
    work,
  );
  const authoritySemanticManifest = runJson(
    "pnpm",
    [
      "exec",
      "antidrift",
      "semantic-manifest",
      "--proof-bucket",
      "authority-index-ownership",
    ],
    work,
  );
  const structuralFactSemanticManifest = runJson(
    "pnpm",
    [
      "exec",
      "antidrift",
      "semantic-manifest",
      "--fact-kind",
      "structuralMatch",
    ],
    work,
  );
  const typeOwnerFactSemanticManifest = runJson(
    "pnpm",
    [
      "exec",
      "antidrift",
      "semantic-manifest",
      "--fact-adapter",
      "typescript-eslint/type-owner",
    ],
    work,
  );

  if (
    reactStateSemanticManifest.map((entry) => entry.id).join(",") !==
      "react-state" ||
    asyncControlSemanticManifest.map((entry) => entry.id).join(",") !==
      "async-control-flow" ||
    tupleShapeSemanticManifest.map((entry) => entry.id).join(",") !==
      "tuple-shape" ||
    authoritySemanticManifest.map((entry) => entry.id).join(",") !==
      "type-owner" ||
    structuralFactSemanticManifest.map((entry) => entry.id).join(",") !==
      "type-owner" ||
    typeOwnerFactSemanticManifest.map((entry) => entry.id).join(",") !==
      "type-owner"
  ) {
    fail(
      `semantic-manifest filters should expose rule/proof/fact slices, got: ${JSON.stringify({ reactStateSemanticManifest, asyncControlSemanticManifest, tupleShapeSemanticManifest, authoritySemanticManifest, structuralFactSemanticManifest, typeOwnerFactSemanticManifest })}`,
    );
  }
  const ruleStatus = runJson(
    "pnpm",
    ["exec", "antidrift", "rule-status", "policy"],
    work,
  );
  const activeRule = ruleStatus.entries.find(
    (entry) => entry.id === "antidrift/no-structural-type-fork",
  );
  const retiredRule = ruleStatus.entries.find(
    (entry) => entry.id === "antidrift/no-status-triplet-state",
  );

  if (
    activeRule?.kind !== "active" ||
    activeRule?.external?.decision !== "own-antidrift" ||
    retiredRule?.kind !== "retired"
  ) {
    fail(
      `rule-status should expose normalized consumer rule metadata, got: ${JSON.stringify(ruleStatus)}`,
    );
  }
  const typeOwnerRuleStatus = runJson(
    "pnpm",
    [
      "exec",
      "antidrift",
      "rule-status",
      "policy",
      "--semantic-adapter",
      "type-owner",
    ],
    work,
  );
  const asyncControlRuleStatus = runJson(
    "pnpm",
    [
      "exec",
      "antidrift",
      "rule-status",
      "policy",
      "--semantic-adapter",
      "async-control-flow",
    ],
    work,
  );
  const tupleShapeRuleStatus = runJson(
    "pnpm",
    [
      "exec",
      "antidrift",
      "rule-status",
      "policy",
      "--semantic-adapter",
      "tuple-shape",
    ],
    work,
  );
  const authorityRuleStatus = runJson(
    "pnpm",
    [
      "exec",
      "antidrift",
      "rule-status",
      "policy",
      "--proof-bucket",
      "authority-index-ownership",
    ],
    work,
  );
  const localAstRuleStatus = runJson(
    "pnpm",
    [
      "exec",
      "antidrift",
      "rule-status",
      "policy",
      "--proof-bucket",
      "local-ast-source-shape",
    ],
    work,
  );
  const retiredRuleStatus = runJson(
    "pnpm",
    ["exec", "antidrift", "rule-status", "policy", "--kind", "retired"],
    work,
  );
  const ecosystemCoveredRuleStatus = runJson(
    "pnpm",
    [
      "exec",
      "antidrift",
      "rule-status",
      "policy",
      "--status",
      "ecosystem-covered",
    ],
    work,
  );
  const reactStateSemanticSummary = runJson(
    "pnpm",
    [
      "exec",
      "antidrift",
      "rule-status",
      "policy",
      "--semantic-summary",
      "--semantic-adapter",
      "react-state",
    ],
    work,
  );
  const localAstSemanticSummary = runJson(
    "pnpm",
    [
      "exec",
      "antidrift",
      "rule-status",
      "policy",
      "--semantic-summary",
      "--proof-bucket",
      "local-ast-source-shape",
    ],
    work,
  );

  if (
    typeOwnerRuleStatus.entries.map((entry) => entry.id).join(",") !==
      "antidrift/no-structural-type-fork" ||
    asyncControlRuleStatus.entries.map((entry) => entry.id).join(",") !==
      "antidrift/no-async-array-method" ||
    tupleShapeRuleStatus.entries.map((entry) => entry.id).join(",") !==
      "antidrift/no-nullable-positional-tuple" ||
    authorityRuleStatus.entries.map((entry) => entry.id).join(",") !==
      "antidrift/no-structural-type-fork" ||
    !localAstRuleStatus.entries.some(
      (entry) => entry.id === "antidrift/no-async-array-method",
    ) ||
    !localAstRuleStatus.entries.some(
      (entry) => entry.id === "antidrift/no-nullable-positional-tuple",
    ) ||
    !localAstRuleStatus.entries.some(
      (entry) => entry.id === "antidrift/no-raw-fetch-in-component",
    ) ||
    retiredRuleStatus.entries.map((entry) => entry.id).join(",") !==
      "antidrift/no-status-triplet-state" ||
    ecosystemCoveredRuleStatus.entries.map((entry) => entry.id).join(",") !==
      "ecosystem/import-cycle" ||
    reactStateSemanticSummary.summaries
      ?.map((summary) => summary.semanticAdapters[0]?.id)
      .join(",") !== "react-state" ||
    reactStateSemanticSummary.summaries?.[0]?.semanticFactContracts
      ?.map((entry) => entry.factKind)
      .join(",") !== "broadSetterCoMutation,resourceLifecycleProof,sourceMemberStateShardCandidate" ||
    !localAstSemanticSummary.summaries?.some(
      (summary) =>
        summary.entry.id === "antidrift/no-async-array-method" &&
        summary.semanticAdapters[0]?.id === "async-control-flow",
    ) ||
    !localAstSemanticSummary.summaries?.some(
      (summary) =>
        summary.entry.id === "antidrift/no-nullable-positional-tuple" &&
        summary.semanticAdapters[0]?.id === "tuple-shape",
    ) ||
    !localAstSemanticSummary.summaries?.some(
      (summary) =>
        summary.entry.id === "antidrift/no-raw-fetch-in-component" &&
        summary.proofBuckets?.join(",") === "local-ast-source-shape",
    )
  ) {
    fail(
      `rule-status filters should expose adapter/proof-bucket/status/semantic-summary slices, got: ${JSON.stringify({ typeOwnerRuleStatus, asyncControlRuleStatus, tupleShapeRuleStatus, authorityRuleStatus, localAstRuleStatus, retiredRuleStatus, ecosystemCoveredRuleStatus, reactStateSemanticSummary, localAstSemanticSummary })}`,
    );
  }

  console.log(
    "6/7  typechecking every public export under supported TS resolution modes ...",
  );
  run(
    "pnpm",
    ["exec", "tsc", "-p", "tsconfig.bundler.json", "--pretty", "false"],
    work,
  );
  run(
    "pnpm",
    ["exec", "tsc", "-p", "tsconfig.nodenext.json", "--pretty", "false"],
    work,
  );

  console.log("7/7  importing every public runtime export ...");
  run("node", ["packages/app/src/runtime.mjs"], work);

  console.log(
    `\n✓ tarball installs, type-checks, imports, and enforces in a consumer monorepo`,
  );
  console.log(
    `  default config kept ${RULE} off; opt-in config fired on drift.ts, async-array shipped behavior matched default and opt-in branch expectations, emitted a structuralMatch fact, and kept clean.ts/package-copy.ts clean; public exports and semantic adapters passed Bundler and NodeNext.`,
  );
  rmSync(work, { recursive: true, force: true });
} catch (error) {
  console.error(error.stdout || error.stderr || error.message || error);
  fail("integration run threw");
}
