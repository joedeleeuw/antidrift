import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runCorpusCases } from "./chaski-corpus.mjs";

const sudocodeRepoCandidates = [
  process.env.SUDOCODE_REPO,
  "/Users/sushi/code/sudocode-main",
].filter(Boolean);
const codebaseAtlasRepoCandidates = [
  process.env.CODEBASE_ATLAS_REPO,
  "/Users/sushi/code/codebase-atlas",
].filter(Boolean);
const murderboxRepoCandidates = [
  process.env.MURDERBOX_REPO,
  "/Users/sushi/code/murderbox",
].filter(Boolean);
const cloudflareAgentsRepoCandidates = [
  process.env.CLOUDFLARE_AGENTS_REPO,
  "/Users/sushi/code/cloudflare-agents",
].filter(Boolean);
const claudeCodeSourceRepoCandidates = [
  process.env.CLAUDE_CODE_SOURCE_REPO,
  "/Users/sushi/code/claude-code-source-code",
].filter(Boolean);
const opencodeRepoCandidates = [
  process.env.OPENCODE_REPO,
  "/Users/sushi/code/opencode",
].filter(Boolean);
const powersyncServiceRepoCandidates = [
  process.env.POWERSYNC_SERVICE_REPO,
  "/Users/sushi/code/powersync-service",
].filter(Boolean);
const coreRuleIds = new Set(["no-restricted-imports"]);
const powersyncSqlRuleOptions = {
  "antidrift/no-sql-string-concat": [
    {
      safeIdentifierMembers: [
        {
          type: "SourceTable",
          member: "escapedIdentifier",
          evidence:
            "PowerSync SourceTable.escapedIdentifier is the owned table identifier escape API; TypeScript proves the receiver type before this exemption applies.",
        },
      ],
      safeTemplateTags: [
        {
          type: "AbstractPostgresConnection",
          member: "sql",
          source:
            "libs/lib-postgres/dist/db/connection/AbstractPostgresConnection.d.ts",
          evidence:
            "PowerSync AbstractPostgresConnection.sql turns template expressions into pgwire statement params; TypeScript proves the receiver/member declaration source in the built package surface before this exemption applies.",
        },
      ],
    },
  ],
};
const cloudflareAgentsSqlRuleOptions = {
  "antidrift/no-sql-string-concat": [
    {
      safeTemplateTags: [
        {
          type: "Agent",
          member: "sql",
          source: "packages/agents/src/index.ts",
          evidence:
            "Cloudflare Agent.sql converts template expressions into storage SQL placeholders before execution; TypeScript proves the receiver/member declaration source before this exemption applies.",
        },
      ],
    },
  ],
};
const opencodeSqlRuleOptions = {
  "antidrift/no-sql-string-concat": [
    {
      safeTemplateTags: [
        {
          module: "drizzle-orm/sql/sql",
          export: "sql",
          evidence:
            "Drizzle sql imported from drizzle-orm/sql/sql is the query-builder tag used with sql.identifier fragments in opencode migrations.",
        },
        {
          module: "drizzle-orm",
          export: "sql",
          evidence:
            "Drizzle sql imported from drizzle-orm is the public query-builder tag used with sql.identifier fragments in opencode core migrations.",
        },
      ],
    },
  ],
};
const sudocodeCanonicalModelForkOptions = {
  "antidrift/no-canonical-model-fork": [
    {
      canonicalEntities: {
        ProjectInfo: "server/src/types/project.ts",
        ProjectsConfig: "server/src/types/project.ts",
      },
    },
  ],
};

const sudocodeCases = [
  {
    id: "sudocode-multi-project-async-foreach-cleanup",
    ruleId: "antidrift/no-async-array-method",
    kind: "drift",
    classification: "ready",
    subproject: "server",
    paths: ["server/tests/integration/multi-project.test.ts"],
    expectedFindings: [
      {
        path: "server/tests/integration/multi-project.test.ts",
        line: 142,
      },
    ],
  },
  {
    id: "sudocode-projects-route-promise-all-map-clean",
    ruleId: "antidrift/no-async-array-method",
    kind: "correct",
    classification: "ready",
    subproject: "server",
    paths: ["server/src/routes/projects.ts"],
  },
  {
    id: "sudocode-executions-page-query-clean",
    ruleId: "antidrift/no-raw-fetch-in-component",
    kind: "correct",
    classification: "ready",
    subproject: "frontend",
    paths: ["frontend/src/pages/ExecutionsPage.tsx"],
  },
  {
    id: "sudocode-issue-detail-effect-deps-clean",
    ruleId: "antidrift/require-effect-deps",
    kind: "correct",
    classification: "ready",
    subproject: "frontend",
    paths: ["frontend/src/pages/IssueDetailPage.tsx"],
  },
  {
    id: "sudocode-execution-view-cancel-resource-lifecycle",
    ruleId: "antidrift/no-handrolled-resource-lifecycle-cells",
    kind: "drift",
    classification: "under-proven",
    subproject: "frontend",
    paths: ["frontend/src/components/executions/ExecutionView.tsx"],
    expectedFindings: [
      {
        path: "frontend/src/components/executions/ExecutionView.tsx",
        line: 463,
      },
      {
        path: "frontend/src/components/executions/ExecutionView.tsx",
        line: 644,
      },
    ],
  },
  {
    id: "sudocode-inline-execution-delete-worktree-resource-lifecycle",
    ruleId: "antidrift/no-handrolled-resource-lifecycle-cells",
    kind: "drift",
    classification: "under-proven",
    subproject: "frontend",
    paths: ["frontend/src/components/executions/InlineExecutionView.tsx"],
    expectedFindings: [
      {
        path: "frontend/src/components/executions/InlineExecutionView.tsx",
        line: 342,
      },
    ],
  },
  {
    id: "sudocode-voice-config-resource-lifecycle",
    ruleId: "antidrift/no-handrolled-resource-lifecycle-cells",
    kind: "drift",
    classification: "under-proven",
    subproject: "frontend",
    paths: ["frontend/src/hooks/useVoiceConfig.ts"],
    expectedFindings: [
      {
        path: "frontend/src/hooks/useVoiceConfig.ts",
        line: 123,
      },
    ],
  },
  {
    id: "sudocode-workflows-route-json-parse-any-row",
    ruleId: "antidrift/no-unsafe-deserialize",
    kind: "drift",
    classification: "ready",
    subproject: "server",
    typeAware: true,
    tsconfig: "server/tsconfig.json",
    paths: ["server/src/routes/workflows.ts"],
    expectedFindings: [
      {
        path: "server/src/routes/workflows.ts",
        line: 199,
      },
    ],
  },
  {
    id: "sudocode-base-workflow-typed-row-json-parse-clean",
    ruleId: "antidrift/no-unsafe-deserialize",
    kind: "correct",
    classification: "ready",
    subproject: "server",
    typeAware: true,
    tsconfig: "server/tsconfig.json",
    paths: ["server/src/workflow/base-workflow-engine.ts"],
  },
  {
    id: "sudocode-config-read-file-json-parse-string-clean",
    ruleId: "antidrift/no-unsafe-deserialize",
    kind: "correct",
    classification: "ready",
    subproject: "server",
    typeAware: true,
    tsconfig: "server/tsconfig.json",
    paths: ["server/src/routes/config.ts"],
  },
  {
    id: "sudocode-workflows-placeholder-in-list-clean",
    ruleId: "antidrift/no-sql-string-concat",
    kind: "correct",
    classification: "ready",
    subproject: "server",
    paths: ["server/src/routes/workflows.ts"],
  },
  {
    id: "sudocode-workflows-sort-allowlist-clean",
    ruleId: "antidrift/no-sql-string-concat",
    kind: "correct",
    classification: "ready",
    subproject: "server",
    paths: ["server/src/routes/workflows.ts"],
  },
  {
    id: "sudocode-base-workflow-static-set-fragments-clean",
    ruleId: "antidrift/no-sql-string-concat",
    kind: "correct",
    classification: "ready",
    subproject: "server",
    paths: ["server/src/workflow/base-workflow-engine.ts"],
  },
  {
    id: "sudocode-execution-service-typed-order-by-clean",
    ruleId: "antidrift/no-sql-string-concat",
    kind: "correct",
    classification: "ready",
    subproject: "server",
    paths: ["server/src/services/execution-service.ts"],
  },
  {
    id: "sudocode-workflow-test-dynamic-update-columns",
    ruleId: "antidrift/no-sql-string-concat",
    kind: "drift",
    classification: "ready",
    subproject: "server",
    paths: ["server/tests/integration/workflow/helpers/workflow-test-setup.ts"],
    expectedFindings: [
      {
        path: "server/tests/integration/workflow/helpers/workflow-test-setup.ts",
        line: 386,
      },
    ],
  },
  {
    id: "sudocode-execution-test-dynamic-update-columns",
    ruleId: "antidrift/no-sql-string-concat",
    kind: "drift",
    classification: "ready",
    subproject: "server",
    paths: ["server/tests/integration/execution/helpers/test-setup.ts"],
    expectedFindings: [
      {
        path: "server/tests/integration/execution/helpers/test-setup.ts",
        line: 179,
      },
    ],
  },
  {
    id: "sudocode-cli-specs-static-sql-fragments-clean",
    ruleId: "antidrift/no-sql-string-concat",
    kind: "correct",
    classification: "ready",
    subproject: "cli",
    paths: ["cli/src/operations/specs.ts"],
  },
  {
    id: "sudocode-cli-issues-static-sql-fragments-clean",
    ruleId: "antidrift/no-sql-string-concat",
    kind: "correct",
    classification: "ready",
    subproject: "cli",
    paths: ["cli/src/operations/issues.ts"],
  },
  {
    id: "sudocode-cli-entity-table-union-clean",
    ruleId: "antidrift/no-sql-string-concat",
    kind: "correct",
    classification: "ready",
    subproject: "cli",
    paths: [
      "cli/src/operations/tags.ts",
      "cli/src/operations/relationships.ts",
      "cli/src/id-generator.ts",
    ],
  },
  {
    id: "sudocode-issues-route-params-without-authz",
    ruleId: "antidrift/require-authz-check",
    kind: "drift",
    classification: "under-proven",
    subproject: "server",
    paths: ["server/src/routes/issues.ts"],
    expectedFindings: [
      {
        path: "server/src/routes/issues.ts",
        line: 78,
      },
      {
        path: "server/src/routes/issues.ts",
        line: 179,
      },
      {
        path: "server/src/routes/issues.ts",
        line: 292,
      },
      {
        path: "server/src/routes/issues.ts",
        line: 378,
      },
    ],
  },
  {
    id: "sudocode-specs-route-params-without-authz",
    ruleId: "antidrift/require-authz-check",
    kind: "drift",
    classification: "under-proven",
    subproject: "server",
    paths: ["server/src/routes/specs.ts"],
    expectedFindings: [
      {
        path: "server/src/routes/specs.ts",
        line: 76,
      },
      {
        path: "server/src/routes/specs.ts",
        line: 183,
      },
      {
        path: "server/src/routes/specs.ts",
        line: 294,
      },
      {
        path: "server/src/routes/specs.ts",
        line: 392,
      },
    ],
  },
  {
    id: "sudocode-relationships-route-params-without-authz",
    ruleId: "antidrift/require-authz-check",
    kind: "drift",
    classification: "under-proven",
    subproject: "server",
    paths: ["server/src/routes/relationships.ts"],
    expectedFindings: [
      {
        path: "server/src/routes/relationships.ts",
        line: 27,
      },
      {
        path: "server/src/routes/relationships.ts",
        line: 67,
      },
      {
        path: "server/src/routes/relationships.ts",
        line: 110,
      },
    ],
  },
  {
    id: "sudocode-executions-route-params-without-authz",
    ruleId: "antidrift/require-authz-check",
    kind: "drift",
    classification: "under-proven",
    subproject: "server",
    paths: ["server/src/routes/executions.ts"],
    expectedFindings: [
      {
        path: "server/src/routes/executions.ts",
        line: 320,
      },
      {
        path: "server/src/routes/executions.ts",
        line: 420,
      },
      {
        path: "server/src/routes/executions.ts",
        line: 461,
      },
      {
        path: "server/src/routes/executions.ts",
        line: 536,
      },
      {
        path: "server/src/routes/executions.ts",
        line: 603,
      },
      {
        path: "server/src/routes/executions.ts",
        line: 641,
      },
      {
        path: "server/src/routes/executions.ts",
        line: 698,
      },
      {
        path: "server/src/routes/executions.ts",
        line: 725,
      },
      {
        path: "server/src/routes/executions.ts",
        line: 785,
      },
      {
        path: "server/src/routes/executions.ts",
        line: 849,
      },
      {
        path: "server/src/routes/executions.ts",
        line: 888,
      },
      {
        path: "server/src/routes/executions.ts",
        line: 952,
      },
      {
        path: "server/src/routes/executions.ts",
        line: 991,
      },
      {
        path: "server/src/routes/executions.ts",
        line: 1060,
      },
      {
        path: "server/src/routes/executions.ts",
        line: 1145,
      },
      {
        path: "server/src/routes/executions.ts",
        line: 1198,
      },
      {
        path: "server/src/routes/executions.ts",
        line: 1252,
      },
      {
        path: "server/src/routes/executions.ts",
        line: 1286,
      },
      {
        path: "server/src/routes/executions.ts",
        line: 1352,
      },
      {
        path: "server/src/routes/executions.ts",
        line: 1420,
      },
      {
        path: "server/src/routes/executions.ts",
        line: 1478,
      },
      {
        path: "server/src/routes/executions.ts",
        line: 1528,
      },
      {
        path: "server/src/routes/executions.ts",
        line: 1760,
      },
      {
        path: "server/src/routes/executions.ts",
        line: 1793,
      },
      {
        path: "server/src/routes/executions.ts",
        line: 1849,
      },
      {
        path: "server/src/routes/executions.ts",
        line: 1893,
      },
    ],
  },
  {
    id: "sudocode-version-route-no-params-clean",
    ruleId: "antidrift/require-authz-check",
    kind: "correct",
    classification: "under-proven",
    subproject: "server",
    paths: ["server/src/routes/version.ts"],
  },
  {
    id: "sudocode-chat-widget-hover-translate-fab",
    ruleId: "antidrift/no-hover-translate-card",
    kind: "correct",
    classification: "retired",
    subproject: "frontend",
    paths: ["frontend/src/components/chat-widget/ChatWidgetFAB.tsx"],
  },
  {
    id: "sudocode-ui-button-no-hover-translate-clean",
    ruleId: "antidrift/no-hover-translate-card",
    kind: "correct",
    classification: "retired",
    subproject: "frontend",
    paths: ["frontend/src/components/ui/button.tsx"],
  },
  {
    id: "sudocode-first-party-plugin-entries-clean",
    ruleId: "antidrift/no-defensive-shape-probing",
    kind: "correct",
    classification: "ready",
    subproject: "cli",
    typeAware: true,
    tsconfig: "cli/tsconfig.json",
    paths: ["cli/src/integrations/plugin-loader.ts"],
  },
  {
    id: "sudocode-plugin-shape-predicate-field-checked-clean",
    ruleId: "antidrift/no-underchecked-type-predicate",
    kind: "correct",
    classification: "ready",
    subproject: "cli",
    typeAware: true,
    tsconfig: "cli/tsconfig.json",
    paths: ["cli/src/integrations/plugin-loader.ts"],
  },
  {
    id: "sudocode-workflow-settings-predicate-field-checked-clean",
    ruleId: "antidrift/no-underchecked-type-predicate",
    kind: "correct",
    classification: "ready",
    subproject: "frontend",
    typeAware: true,
    tsconfig: "frontend/tsconfig.json",
    paths: ["frontend/src/components/workflows/CreateWorkflowDialog.tsx"],
  },
  {
    id: "sudocode-coalesced-update-union-predicate-clean",
    ruleId: "antidrift/no-underchecked-type-predicate",
    kind: "correct",
    classification: "ready",
    subproject: "server",
    typeAware: true,
    tsconfig: "server/tsconfig.json",
    paths: ["server/src/execution/output/coalesced-types.ts"],
  },
  {
    id: "sudocode-project-info-frontend-model-fork",
    ruleId: "antidrift/no-canonical-model-fork",
    kind: "drift",
    classification: "ready",
    subproject: "frontend",
    programFiles: [
      "server/src/types/project.ts",
      "frontend/src/types/project.ts",
    ],
    ruleOptions: sudocodeCanonicalModelForkOptions,
    paths: ["frontend/src/types/project.ts"],
    expectedFindings: [
      {
        path: "frontend/src/types/project.ts",
        line: 5,
      },
    ],
    unexpectedFindings: [
      {
        path: "frontend/src/types/project.ts",
        line: 22,
      },
    ],
  },
  {
    id: "sudocode-project-info-owner-clean",
    ruleId: "antidrift/no-canonical-model-fork",
    kind: "correct",
    classification: "ready",
    subproject: "server",
    programFiles: [
      "server/src/types/project.ts",
      "frontend/src/types/project.ts",
    ],
    ruleOptions: sudocodeCanonicalModelForkOptions,
    paths: ["server/src/types/project.ts"],
  },
];

const codebaseAtlasCases = [
  {
    id: "atlas-debug-bundle-promise-all-map-clean",
    ruleId: "antidrift/no-async-array-method",
    kind: "correct",
    classification: "ready",
    subproject: "app",
    paths: ["src/services/debugBundleService.ts"],
  },
  {
    id: "atlas-persistence-curation-string-json-parse-clean",
    ruleId: "antidrift/no-unsafe-deserialize",
    kind: "correct",
    classification: "ready",
    subproject: "app",
    typeAware: true,
    tsconfig: "tsconfig.json",
    paths: ["src/programs/persistenceCuration.ts"],
  },
  {
    id: "atlas-city-route-component-fetch",
    ruleId: "antidrift/no-raw-fetch-in-component",
    kind: "drift",
    classification: "ready",
    subproject: "app",
    paths: ["src/routes/atlas.city.tsx"],
    expectedFindings: [
      {
        path: "src/routes/atlas.city.tsx",
        line: 50,
      },
      {
        path: "src/routes/atlas.city.tsx",
        line: 76,
      },
    ],
  },
  {
    id: "atlas-game-state-shell-effect-deps-clean",
    ruleId: "antidrift/require-effect-deps",
    kind: "correct",
    classification: "ready",
    subproject: "app",
    paths: ["src/components/AtlasGameStateShell.tsx"],
  },
  {
    id: "atlas-real-program-parser-full-excerpt-selector-wrapper",
    ruleId: "antidrift/no-trivial-selector-wrapper",
    kind: "drift",
    classification: "ready",
    subproject: "app",
    paths: ["src/parsing/treeSitterRealProgramParser.ts"],
    expectedFindings: [
      {
        path: "src/parsing/treeSitterRealProgramParser.ts",
        line: 917,
      },
    ],
  },
  {
    id: "atlas-generated-state-manifest-zod-boundary-clean",
    ruleId: "antidrift/no-redundant-zod-parse",
    kind: "correct",
    classification: "ready",
    subproject: "app",
    typeAware: true,
    tsconfig: "tsconfig.json",
    paths: ["src/services/generatedStateIntegrityService.ts"],
  },
  {
    id: "atlas-schema-contract-test-assertion-clean",
    ruleId: "antidrift/no-redundant-zod-parse",
    kind: "correct",
    classification: "ready",
    subproject: "app",
    typeAware: true,
    tsconfig: "tsconfig.json",
    paths: ["src/test/generatedStateDebugSimulation.test.ts"],
  },
  {
    id: "atlas-invariant-contract-test-assertion-clean",
    ruleId: "antidrift/no-redundant-zod-parse",
    kind: "correct",
    classification: "ready",
    subproject: "app",
    typeAware: true,
    tsconfig: "tsconfig.json",
    paths: ["src/test/invariantService.test.ts"],
  },
  {
    id: "atlas-needle-renderer-userdata-color-appeasement-cast",
    ruleId: "antidrift/no-appeasement-cast",
    kind: "drift",
    classification: "ready",
    subproject: "app",
    typeAware: true,
    tsconfig: "tsconfig.json",
    paths: ["src/needle/AtlasNeedleRenderer.ts"],
    expectedFindings: [
      {
        path: "src/needle/AtlasNeedleRenderer.ts",
        line: 205,
      },
    ],
  },
  {
    id: "atlas-terrain-layout-anchor-appeasement-cast",
    ruleId: "antidrift/no-appeasement-cast",
    kind: "drift",
    classification: "ready",
    subproject: "app",
    typeAware: true,
    tsconfig: "tsconfig.json",
    paths: ["src/programs/persistenceCuration.ts"],
    expectedFindings: [
      {
        path: "src/programs/persistenceCuration.ts",
        line: 1293,
      },
    ],
  },
  {
    id: "atlas-scene-event-typed-dom-event-clean",
    ruleId: "antidrift/no-appeasement-cast",
    kind: "correct",
    classification: "ready",
    subproject: "app",
    typeAware: true,
    tsconfig: "tsconfig.json",
    paths: ["src/bridge/AtlasSceneBridge.ts"],
  },
  {
    id: "atlas-terrain-layout-anchor-field-checked-predicate-clean",
    ruleId: "antidrift/no-underchecked-type-predicate",
    kind: "correct",
    classification: "ready",
    subproject: "app",
    typeAware: true,
    tsconfig: "tsconfig.json",
    paths: ["src/programs/persistenceCuration.ts"],
  },
  {
    id: "atlas-concept-signals-primitive-predicate-clean",
    ruleId: "antidrift/no-underchecked-type-predicate",
    kind: "correct",
    classification: "ready",
    subproject: "app",
    typeAware: true,
    tsconfig: "tsconfig.json",
    paths: ["src/programs/repoComprehensionSurfaces.ts"],
  },
  {
    id: "atlas-three-material-union-predicate-clean",
    ruleId: "antidrift/no-underchecked-type-predicate",
    kind: "correct",
    classification: "ready",
    subproject: "app",
    typeAware: true,
    tsconfig: "tsconfig.json",
    paths: ["src/needle/AtlasNeedleRenderer.ts"],
  },
  {
    id: "atlas-language-counts-entries-clean",
    ruleId: "antidrift/no-defensive-shape-probing",
    kind: "correct",
    classification: "ready",
    subproject: "app",
    typeAware: true,
    tsconfig: "tsconfig.json",
    paths: ["tools/write-generated-state-debug-simulation-artifacts.ts"],
  },
];

const murderboxCases = [
  {
    id: "murderbox-chat-module-app-fetch-clean",
    ruleId: "antidrift/no-raw-fetch-in-component",
    kind: "correct",
    classification: "ready",
    subproject: "client",
    paths: ["apps/client/app/(chat)/index.tsx"],
  },
  {
    id: "murderbox-client-api-proxy-fetch-clean",
    ruleId: "antidrift/no-raw-fetch-in-component",
    kind: "correct",
    classification: "ready",
    subproject: "client",
    paths: ["apps/client/app/api/[...path]+api.ts"],
  },
  {
    id: "murderbox-theme-effect-deps-clean",
    ruleId: "antidrift/require-effect-deps",
    kind: "correct",
    classification: "ready",
    subproject: "client",
    paths: ["apps/client/src/lib/theme.ts"],
  },
  {
    id: "murderbox-auth-form-submit-lifecycle-clean",
    ruleId: "antidrift/no-handrolled-resource-lifecycle-cells",
    kind: "correct",
    classification: "under-proven",
    subproject: "client",
    paths: ["apps/client/src/components/auth/auth-form.tsx"],
  },
  {
    id: "murderbox-chat-item-key-selector-wrapper",
    ruleId: "antidrift/no-trivial-selector-wrapper",
    kind: "drift",
    classification: "ready",
    subproject: "client",
    paths: ["apps/client/src/components/chat/message-list.tsx"],
    expectedFindings: [
      {
        path: "apps/client/src/components/chat/message-list.tsx",
        line: 192,
      },
    ],
  },
  {
    id: "murderbox-machine-setup-route-redundant-response-parse",
    ruleId: "antidrift/no-redundant-zod-parse",
    kind: "drift",
    classification: "ready",
    subproject: "api",
    typeAware: true,
    tsconfig: "apps/api/tsconfig.json",
    paths: ["apps/api/app/api/machines/setup/route.ts"],
    expectedFindings: [
      {
        path: "apps/api/app/api/machines/setup/route.ts",
        line: 27,
      },
    ],
  },
  {
    id: "murderbox-workspace-registry-normalization-clean",
    ruleId: "antidrift/no-redundant-zod-parse",
    kind: "correct",
    classification: "ready",
    subproject: "api",
    typeAware: true,
    tsconfig: "apps/api/tsconfig.json",
    paths: ["apps/api/lib/server/workspace-projects.ts"],
  },
];

const cloudflareAgentsCases = [
  {
    id: "cloudflare-voice-parameterized-sql-tag-clean",
    ruleId: "antidrift/no-sql-string-concat",
    kind: "known-gap",
    classification: "under-proven",
    subproject: "packages/voice",
    paths: ["packages/voice/src/voice.ts"],
    reason:
      "Cloudflare Voice uses Agent.sql through a generic mixin constraint, but this external checkout's package tsconfig extends agents/tsconfig without an install-resolvable package path. Keep parked until the member proof can run type-aware without a local tsconfig shim.",
  },
  {
    id: "cloudflare-ai-chat-parameterized-sql-tag-clean",
    ruleId: "antidrift/no-sql-string-concat",
    kind: "known-gap",
    classification: "under-proven",
    subproject: "packages/ai-chat",
    paths: ["packages/ai-chat/src/index.ts"],
    reason:
      "Cloudflare AI Chat extends Agent and uses Agent.sql, but this external checkout's package tsconfig extends agents/tsconfig without an install-resolvable package path. Keep parked until the member proof can run type-aware without a local tsconfig shim.",
  },
  {
    id: "cloudflare-agents-parameterized-sql-tag-clean",
    ruleId: "antidrift/no-sql-string-concat",
    kind: "correct",
    classification: "ready",
    subproject: "packages/agents",
    typeAware: true,
    tsconfig: "packages/agents/tsconfig.json",
    ruleOptions: cloudflareAgentsSqlRuleOptions,
    paths: ["packages/agents/src/index.ts"],
  },
  {
    id: "cloudflare-shell-sanitized-namespace-table-identifiers",
    ruleId: "antidrift/no-sql-string-concat",
    kind: "correct",
    classification: "ready",
    subproject: "packages/shell",
    paths: ["packages/shell/src/filesystem.ts"],
  },
  {
    id: "cloudflare-codemode-static-column-map-clean",
    ruleId: "antidrift/no-sql-string-concat",
    kind: "correct",
    classification: "ready",
    subproject: "examples/codemode",
    paths: ["examples/codemode/src/tools.ts"],
  },
  {
    id: "cloudflare-playground-plain-table-name-query",
    ruleId: "antidrift/no-sql-string-concat",
    kind: "drift",
    classification: "ready",
    subproject: "examples/playground",
    paths: ["examples/playground/src/demos/core/SqlDemo.tsx"],
    expectedFindings: [
      {
        path: "examples/playground/src/demos/core/SqlDemo.tsx",
        line: 133,
      },
    ],
  },
  {
    id: "cloudflare-worker-bundler-playground-resource-lifecycle",
    ruleId: "antidrift/no-handrolled-resource-lifecycle-cells",
    kind: "drift",
    classification: "under-proven",
    subproject: "examples/worker-bundler-playground",
    paths: ["examples/worker-bundler-playground/src/client.tsx"],
    expectedFindings: [
      {
        path: "examples/worker-bundler-playground/src/client.tsx",
        line: 76,
      },
    ],
  },
  {
    id: "cloudflare-github-webhook-connect-resource-lifecycle",
    ruleId: "antidrift/no-handrolled-resource-lifecycle-cells",
    kind: "drift",
    classification: "under-proven",
    subproject: "examples/github-webhook",
    paths: ["examples/github-webhook/src/client.tsx"],
    expectedFindings: [
      {
        path: "examples/github-webhook/src/client.tsx",
        line: 160,
      },
    ],
  },
  {
    id: "cloudflare-think-chat-webhook-setup-resource-lifecycle",
    ruleId: "antidrift/no-handrolled-resource-lifecycle-cells",
    kind: "drift",
    classification: "under-proven",
    subproject: "examples/think-chat-sdk",
    paths: ["examples/think-chat-sdk/src/client.tsx"],
    expectedFindings: [
      {
        path: "examples/think-chat-sdk/src/client.tsx",
        line: 90,
      },
    ],
  },
  {
    id: "cloudflare-think-submissions-submit-resource-lifecycle",
    ruleId: "antidrift/no-handrolled-resource-lifecycle-cells",
    kind: "drift",
    classification: "under-proven",
    subproject: "examples/think-submissions",
    paths: ["examples/think-submissions/src/client.tsx"],
    expectedFindings: [
      {
        path: "examples/think-submissions/src/client.tsx",
        line: 139,
      },
    ],
  },
  {
    id: "cloudflare-ai-chat-large-message-payload-clean",
    ruleId: "antidrift/no-sql-string-concat",
    kind: "correct",
    classification: "ready",
    subproject: "packages/ai-chat",
    paths: ["packages/ai-chat/e2e/chat.spec.ts"],
  },
  {
    id: "cloudflare-ai-chat-websocket-json-contract-casts",
    ruleId: "antidrift/no-appeasement-cast",
    kind: "known-gap",
    classification: "ready",
    subproject: "packages/ai-chat",
    typeAware: true,
    tsconfig: "packages/ai-chat/tsconfig.json",
    paths: ["packages/ai-chat/src/ws-chat-transport.ts"],
    reason:
      "Production WebSocket handlers parse event.data and assert OutgoingMessage/UIMessageChunk contracts before validation, but this external checkout's tsconfig extends agents/tsconfig without an install-resolvable package path.",
  },
  {
    id: "cloudflare-assistant-agent-config-json-any-row",
    ruleId: "antidrift/no-unsafe-deserialize",
    kind: "known-gap",
    classification: "ready",
    subproject: "examples/assistant",
    typeAware: true,
    tsconfig: "examples/assistant/tsconfig.json",
    paths: ["examples/assistant/src/server.ts"],
    reason:
      "This checkout's assistant server no longer contains the original broad config parse, and the project tsconfig extends agents/tsconfig without an install-resolvable package path in this external clone.",
  },
  {
    id: "cloudflare-voice-text-stream-string-json-clean",
    ruleId: "antidrift/no-unsafe-deserialize",
    kind: "known-gap",
    classification: "ready",
    subproject: "packages/voice",
    typeAware: true,
    tsconfig: "packages/voice/tsconfig.json",
    paths: ["packages/voice/src/text-stream.ts"],
    reason:
      "Clean parse-at-edge control is still useful, but this external checkout's tsconfig extends agents/tsconfig without an install-resolvable package path.",
  },
  {
    id: "cloudflare-gadgets-chat-nested-event-json-any",
    ruleId: "antidrift/no-unsafe-deserialize",
    kind: "known-gap",
    classification: "ready",
    subproject: "experimental/gadgets-chat",
    typeAware: true,
    tsconfig: "experimental/gadgets-chat/tsconfig.json",
    paths: ["experimental/gadgets-chat/src/client.tsx"],
    reason:
      "Non-blocking broad nested parse-input inventory; this external checkout's tsconfig extends agents/tsconfig without an install-resolvable package path.",
  },
  {
    id: "cloudflare-twilio-websocket-string-guard-clean",
    ruleId: "antidrift/no-unsafe-deserialize",
    kind: "known-gap",
    classification: "ready",
    subproject: "voice-providers/twilio",
    typeAware: true,
    tsconfig: "voice-providers/twilio/tsconfig.json",
    paths: ["voice-providers/twilio/src/index.ts"],
    reason:
      "Guarded WebSocket string control is still useful, but this external checkout's tsconfig extends agents/tsconfig without an install-resolvable package path.",
  },
];

const claudeCodeSourceCases = [
  {
    id: "claude-assistant-history-every-render-effects",
    ruleId: "antidrift/require-effect-deps",
    kind: "drift",
    classification: "ready",
    subproject: "app",
    paths: ["src/hooks/useAssistantHistory.ts"],
    expectedFindings: [
      {
        path: "src/hooks/useAssistantHistory.ts",
        line: 199,
      },
      {
        path: "src/hooks/useAssistantHistory.ts",
        line: 218,
      },
    ],
  },
  {
    id: "claude-virtual-scroll-every-render-layout-effects",
    ruleId: "antidrift/require-effect-deps",
    kind: "drift",
    classification: "ready",
    subproject: "app",
    paths: ["src/hooks/useVirtualScroll.ts"],
    expectedFindings: [
      {
        path: "src/hooks/useVirtualScroll.ts",
        line: 591,
      },
      {
        path: "src/hooks/useVirtualScroll.ts",
        line: 619,
      },
    ],
  },
];

const opencodeCases = [
  {
    id: "opencode-drizzle-sql-template-identifiers-clean",
    ruleId: "antidrift/no-sql-string-concat",
    kind: "correct",
    classification: "ready",
    subproject: "effect-drizzle-sqlite",
    ruleOptions: opencodeSqlRuleOptions,
    paths: [
      "packages/effect-drizzle-sqlite/src/up-migrations/effect-sqlite.ts",
      "packages/effect-drizzle-sqlite/src/up-migrations/sqlite.ts",
      "packages/effect-drizzle-sqlite/src/sqlite-core/effect/session.ts",
      "packages/core/src/database/migration.ts",
    ],
  },
  {
    id: "opencode-stats-local-sql-escaper-clean",
    ruleId: "antidrift/no-sql-string-concat",
    kind: "correct",
    classification: "ready",
    subproject: "stats-core",
    paths: ["packages/stats/core/src/domain/inference.ts"],
  },
  {
    id: "opencode-console-benchmark-list-result-json",
    ruleId: "antidrift/no-unsafe-deserialize",
    kind: "known-gap",
    classification: "ready",
    subproject: "console-app",
    typeAware: true,
    tsconfig: "packages/console/app/tsconfig.json",
    paths: ["packages/console/app/src/routes/bench/index.tsx"],
    reason:
      "Benchmark rows still cast JSON.parse output to BenchmarkResult, but the current no-unsafe-deserialize rule is scoped to any/unknown parse input. This is a parse-output contract gap, not a current-rule drift fixture.",
  },
  {
    id: "opencode-console-benchmark-detail-result-json",
    ruleId: "antidrift/no-unsafe-deserialize",
    kind: "known-gap",
    classification: "ready",
    subproject: "console-app",
    typeAware: true,
    tsconfig: "packages/console/app/tsconfig.json",
    paths: ["packages/console/app/src/routes/bench/[id].tsx"],
    reason:
      "Benchmark detail rows still cast JSON.parse output to BenchmarkResult, but the current no-unsafe-deserialize rule is scoped to any/unknown parse input. This is a parse-output contract gap, not a current-rule drift fixture.",
  },
  {
    id: "opencode-zen-provider-payload-replacer-clean",
    ruleId: "antidrift/no-defensive-shape-probing",
    kind: "correct",
    classification: "ready",
    subproject: "console-app",
    typeAware: true,
    tsconfig: "packages/console/app/tsconfig.json",
    paths: ["packages/console/app/src/routes/zen/util/handler.ts"],
  },
  {
    id: "opencode-ui-trigger-title-required-field-clean",
    ruleId: "antidrift/no-underchecked-type-predicate",
    kind: "correct",
    classification: "ready",
    subproject: "ui",
    typeAware: true,
    tsconfig: "packages/ui/tsconfig.json",
    paths: ["packages/ui/src/components/basic-tool.tsx"],
    reason:
      "TriggerTitle has one required field; optional field sufficiency remains inventory rather than blocking proof.",
  },
];

const powersyncServiceCases = [
  {
    id: "powersync-mysql-raw-source-table-name",
    ruleId: "antidrift/no-sql-string-concat",
    kind: "drift",
    classification: "ready",
    subproject: "module-mysql",
    paths: ["modules/module-mysql/src/api/MySQLRouteAPIAdapter.ts"],
    expectedFindings: [
      {
        path: "modules/module-mysql/src/api/MySQLRouteAPIAdapter.ts",
        line: 235,
      },
    ],
  },
  {
    id: "powersync-mysql-imported-escaped-table-helper-clean",
    ruleId: "antidrift/no-sql-string-concat",
    kind: "correct",
    classification: "ready",
    subproject: "module-mysql",
    typeAware: true,
    tsconfig: "modules/module-mysql/tsconfig.json",
    ruleOptions: powersyncSqlRuleOptions,
    paths: ["modules/module-mysql/src/replication/BinLogStream.ts"],
  },
  {
    id: "powersync-postgres-escaped-identifier-member-clean",
    ruleId: "antidrift/no-sql-string-concat",
    kind: "correct",
    classification: "ready",
    subproject: "module-postgres",
    typeAware: true,
    tsconfig: "modules/module-postgres/tsconfig.json",
    ruleOptions: powersyncSqlRuleOptions,
    paths: [
      "modules/module-postgres/src/replication/WalStream.ts",
      "modules/module-postgres/src/replication/replication-utils.ts",
    ],
  },
  {
    id: "powersync-postgres-storage-numbered-placeholder-fragment-clean",
    ruleId: "antidrift/no-sql-string-concat",
    kind: "correct",
    classification: "ready",
    subproject: "module-postgres-storage",
    typeAware: true,
    tsconfig: "modules/module-postgres-storage/tsconfig.json",
    ruleOptions: powersyncSqlRuleOptions,
    paths: [
      "modules/module-postgres-storage/src/storage/PostgresSyncRulesStorage.ts",
    ],
  },
];

const externalCorpora = [
  {
    name: "sudocode-main",
    label: "Sudocode",
    repoCandidates: sudocodeRepoCandidates,
    cases: sudocodeCases,
  },
  {
    name: "codebase-atlas",
    label: "Codebase Atlas",
    repoCandidates: codebaseAtlasRepoCandidates,
    cases: codebaseAtlasCases,
  },
  {
    name: "murderbox",
    label: "Murderbox",
    repoCandidates: murderboxRepoCandidates,
    cases: murderboxCases,
  },
  {
    name: "cloudflare-agents",
    label: "Cloudflare Agents",
    repoCandidates: cloudflareAgentsRepoCandidates,
    cases: cloudflareAgentsCases,
  },
  {
    name: "claude-code-source",
    label: "Claude Code Source",
    repoCandidates: claudeCodeSourceRepoCandidates,
    cases: claudeCodeSourceCases,
  },
  {
    name: "opencode",
    label: "opencode",
    repoCandidates: opencodeRepoCandidates,
    cases: opencodeCases,
  },
  {
    name: "powersync-service",
    label: "PowerSync service",
    repoCandidates: powersyncServiceRepoCandidates,
    cases: powersyncServiceCases,
  },
];
const defaultCases = externalCorpora.flatMap((entry) => entry.cases);

function parseCsv(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeRuleId(rule) {
  if (rule.includes("/")) return rule;
  if (coreRuleIds.has(rule)) return rule;
  return `antidrift/${rule}`;
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const valueArgHandlers = {
  "--repo": (out, value) => {
    out.repo = value;
  },
  "--corpus": (out, value) => {
    out.corpus = value;
  },
  "--slice": (out, value) => {
    out.slice = value;
  },
  "--output": (out, value) => {
    out.output = value;
  },
  "--rules": (out, value) => {
    out.rules = parseCsv(value).map(normalizeRuleId);
  },
  "--min-repositories": (out, value) => {
    out.minRepositories = parsePositiveInteger(value, out.minRepositories);
  },
  "--min-drift-repositories": (out, value) => {
    out.minDriftRepositories = parsePositiveInteger(
      value,
      out.minDriftRepositories,
    );
  },
};

function applyValueArg(out, arg, value) {
  const handler = valueArgHandlers[arg];
  if (!handler || !value) return false;
  handler(out, value);
  return true;
}

function parseArgs(argv) {
  const out = {
    repo: null,
    corpus: null,
    slice: "external-corpus",
    output: null,
    require: false,
    rules: null,
    minRepositories: 1,
    minDriftRepositories: 0,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (applyValueArg(out, arg, next)) {
      i += 1;
    } else if (arg === "--require") {
      out.require = true;
    }
  }
  return out;
}

function selectedCorpora(corpus) {
  if (!corpus) return externalCorpora;
  return externalCorpora.filter((entry) => entry.name === corpus);
}

function externalSlice(sharedOptions) {
  return sharedOptions.slice ?? "external-corpus";
}

function unknownCorpusSummary(corpus, sharedOptions) {
  return {
    schemaVersion: 1,
    corpus: "external",
    slice: externalSlice(sharedOptions),
    decision: "fail",
    reason: `Unknown external corpus: ${corpus}. Known: ${externalCorpora.map((entry) => entry.name).join(", ")}`,
    repositories: [],
  };
}

function externalDecision({
  failed,
  passed,
  driftPassed,
  minRepositories,
  minDriftRepositories,
  require,
}) {
  if (failed) return "fail";
  if (driftPassed < minDriftRepositories) return passed > 0 ? "fail" : "skip";
  if (passed >= minRepositories) return "pass";
  if (passed > 0) return "fail";
  if (require) return "fail";
  return "skip";
}

function externalReason({
  decision,
  failed,
  passed,
  driftPassed,
  minRepositories,
  minDriftRepositories,
}) {
  if (decision === "skip") {
    return "No external corpus repositories were found. Pass --repo with --corpus or set a matching environment variable.";
  }
  if (!failed && driftPassed < minDriftRepositories) {
    return `Only ${driftPassed} external corpus repositories had passing drift cases; ${minDriftRepositories} required for this slice.`;
  }
  if (!failed && passed > 0 && passed < minRepositories) {
    return `Only ${passed} external corpus repositories passed; ${minRepositories} required for this slice.`;
  }
  return null;
}

function repositoryHasPassingDrift(result) {
  if (result.decision !== "pass") return false;
  return result.cases.some(
    (testCase) => testCase.kind === "drift" && testCase.decision === "pass",
  );
}

function runExternalCorpus(entry, sharedOptions) {
  return runCorpusCases({
    corpus: entry.name,
    corpusLabel: entry.label,
    repoCandidates: entry.repoCandidates,
    cases: entry.cases,
    output: null,
    report: () => {},
    ...sharedOptions,
  });
}

function emitSummary(summary, output, report) {
  const json = `${JSON.stringify(summary, null, 2)}\n`;
  if (output) {
    writeFileSync(resolve(output), json, "utf8");
  } else {
    report(json.trimEnd());
  }
}

export async function externalCorpus(options = {}) {
  const {
    corpus = null,
    output = null,
    report = console.log,
    minRepositories = 1,
    minDriftRepositories = 0,
    ...sharedOptions
  } = options;
  const corpora = selectedCorpora(corpus);
  if (corpus && corpora.length === 0) {
    const summary = unknownCorpusSummary(corpus, sharedOptions);
    report(JSON.stringify(summary, null, 2));
    return summary;
  }

  const requireIndividualRepository = Boolean(
    sharedOptions.require && (corpus || sharedOptions.repo),
  );
  const repositories = await Promise.all(
    corpora.map((entry) =>
      runExternalCorpus(entry, {
        ...sharedOptions,
        require: requireIndividualRepository,
      }),
    ),
  );

  const passed = repositories.filter(
    (result) => result.decision === "pass",
  ).length;
  const driftPassed = repositories.filter(repositoryHasPassingDrift).length;
  const failed = repositories.some((result) => result.decision === "fail");
  const decision = externalDecision({
    failed,
    passed,
    driftPassed,
    minRepositories,
    minDriftRepositories,
    require: sharedOptions.require,
  });
  const reason = externalReason({
    decision,
    failed,
    passed,
    driftPassed,
    minRepositories,
    minDriftRepositories,
  });
  const summary = {
    schemaVersion: 1,
    corpus: "external",
    slice: externalSlice(sharedOptions),
    decision,
    minRepositories,
    minDriftRepositories,
    driftRepositories: driftPassed,
    repositories,
  };
  if (reason) summary.reason = reason;
  emitSummary(summary, output, report);
  return summary;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await externalCorpus(parseArgs(process.argv.slice(2)));
  if (result.decision === "fail") process.exitCode = 1;
}

export {
  defaultCases,
  parseArgs,
  sudocodeCases,
  codebaseAtlasCases,
  murderboxCases,
  cloudflareAgentsCases,
  claudeCodeSourceCases,
};
