import { resolve } from "node:path";
import { homedir } from "node:os";

const sudocodeRepoCandidates = [
  process.env.SUDOCODE_REPO,
  resolve(homedir(), "code", "sudocode-main"),
].filter(Boolean);
const cloudflareAgentsRepoCandidates = [
  process.env.CLOUDFLARE_AGENTS_REPO,
  resolve(homedir(), "code", "cloudflare-agents"),
].filter(Boolean);
const claudeCodeSourceRepoCandidates = [
  process.env.CLAUDE_CODE_SOURCE_REPO,
  resolve(homedir(), "code", "claude-code-src-code"),
  resolve(homedir(), "code", "claude-code-source-code"),
].filter(Boolean);
const opencodeRepoCandidates = [
  process.env.OPENCODE_REPO,
  resolve(homedir(), "code", "opencode"),
].filter(Boolean);
const powersyncServiceRepoCandidates = [
  process.env.POWERSYNC_SERVICE_REPO,
  resolve(homedir(), "code", "powersync-service"),
].filter(Boolean);
export const coreRuleIds = new Set(["no-restricted-imports"]);
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
const sudocodeRequireAuthzCheckOptions = {
  "antidrift/require-authz-check": [
    {
      authzFunctions: ["requireProject"],
    },
  ],
};

export const sudocodeCases = [
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
    classification: "ready",
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
    classification: "ready",
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
    classification: "ready",
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
    classification: "ready",
    subproject: "server",
    paths: ["server/src/routes/issues.ts"],
    ruleOptions: sudocodeRequireAuthzCheckOptions,
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
    classification: "ready",
    subproject: "server",
    paths: ["server/src/routes/specs.ts"],
    ruleOptions: sudocodeRequireAuthzCheckOptions,
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
    classification: "ready",
    subproject: "server",
    paths: ["server/src/routes/relationships.ts"],
    ruleOptions: sudocodeRequireAuthzCheckOptions,
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
    classification: "ready",
    subproject: "server",
    paths: ["server/src/routes/executions.ts"],
    ruleOptions: sudocodeRequireAuthzCheckOptions,
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
    classification: "ready",
    subproject: "server",
    paths: ["server/src/routes/version.ts"],
    ruleOptions: sudocodeRequireAuthzCheckOptions,
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

export const cloudflareAgentsCases = [
  {
    id: "cloudflare-voice-parameterized-sql-tag-clean",
    ruleId: "antidrift/no-sql-string-concat",
    kind: "known-gap",
    classification: "ready",
    subproject: "packages/voice",
    paths: ["packages/voice/src/voice.ts"],
    reason:
      "Cloudflare Voice uses Agent.sql through a generic mixin constraint, but this external checkout's package tsconfig extends agents/tsconfig without an install-resolvable package path. Keep parked until the member proof can run type-aware without a local tsconfig shim.",
  },
  {
    id: "cloudflare-ai-chat-parameterized-sql-tag-clean",
    ruleId: "antidrift/no-sql-string-concat",
    kind: "known-gap",
    classification: "ready",
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
    classification: "ready",
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
    classification: "ready",
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
    classification: "ready",
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
    classification: "ready",
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
];

export const claudeCodeSourceCases = [
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

export const opencodeCases = [
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

export const powersyncServiceCases = [
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

export const externalCorpora = [
  {
    name: "sudocode-main",
    label: "Sudocode",
    repoCandidates: sudocodeRepoCandidates,
    cases: sudocodeCases,
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
export const defaultCases = externalCorpora.flatMap((entry) => entry.cases);
