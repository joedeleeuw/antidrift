import { resolve } from "node:path";
import { homedir } from "node:os";

const sudocodeRepoCandidates = [
  process.env.SUDOCODE_REPO,
  resolve(homedir(), "code", "sudocode-main"),
].filter(Boolean);

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
      {
        path: "server/src/routes/workflows.ts",
        line: 201,
      },
      {
        path: "server/src/routes/workflows.ts",
        line: 208,
      },
      {
        path: "server/src/routes/workflows.ts",
        line: 793,
      },
      {
        path: "server/src/routes/workflows.ts",
        line: 1010,
      },
      {
        path: "server/src/routes/workflows.ts",
        line: 1012,
      },
      {
        path: "server/src/routes/workflows.ts",
        line: 1019,
      },
      {
        path: "server/src/routes/workflows.ts",
        line: 1598,
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

export const sudocodeCorpora = [
  {
    name: "sudocode-main",
    label: "Sudocode",
    repoCandidates: sudocodeRepoCandidates,
    cases: sudocodeCases,
  },
];
