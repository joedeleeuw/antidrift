import { existsSync, writeFileSync } from "node:fs";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import eslintComments from "@eslint-community/eslint-plugin-eslint-comments";
import tsParser from "@typescript-eslint/parser";
import importX from "eslint-plugin-import-x";
import plugin from "../eslint-plugin/index.js";

const defaultRepoCandidates = [process.env.CHASKI_REPO, "/Users/sushi/code/chaski"].filter(Boolean);
const defaultTypeAwareProjects = {
  bff: "src/frontend/bff/tsconfig.json",
};
const coreRuleIds = new Set(["no-restricted-imports"]);
const structuralTypeForkGeneratedOptions = {
  "antidrift/no-structural-type-fork": [
    {
      generatedSources: {
        chaskiProto: {
          generated: "src/frontend/bff/gen/ts",
        },
      },
    },
  ],
};
const canonicalModelForkOptions = {
  "antidrift/no-canonical-model-fork": [
    {
      canonicalEntities: {
        ActionItem: "src/frontend/portal/types/reports.ts",
        Stop: "src/frontend/portal/types/reports.ts",
        ActionItemsReport: "src/frontend/portal/types/reports.ts",
      },
    },
  ],
};

export const defaultCases = [
  {
    id: "bff-posthog-gateway-unsafe-cast-chain",
    ruleId: "antidrift/no-unsafe-cast-chain",
    kind: "drift",
    classification: "ready",
    subproject: "bff",
    paths: ["src/frontend/bff/api/gateways/posthog-gateway.ts"],
    expectedFindings: [
      {
        path: "src/frontend/bff/api/gateways/posthog-gateway.ts",
        line: 733,
      },
    ],
  },
  {
    id: "bff-orders-service-clean-cast-chain",
    ruleId: "antidrift/no-unsafe-cast-chain",
    kind: "correct",
    classification: "ready",
    subproject: "bff",
    paths: ["src/frontend/bff/api/services/orders-service.ts"],
  },
  {
    id: "portal-accounts-clean-cast-chain",
    ruleId: "antidrift/no-unsafe-cast-chain",
    kind: "correct",
    classification: "ready",
    subproject: "frontend",
    paths: ["src/frontend/portal/modules/Accounts/Accounts.tsx"],
  },
  {
    id: "portal-api-service-axios-error-appeasement-cast",
    ruleId: "antidrift/no-appeasement-cast",
    kind: "drift",
    classification: "ready",
    subproject: "frontend",
    typeAware: true,
    tsconfig: "src/frontend/portal/tsconfig.json",
    paths: ["src/frontend/portal/api/apiService.ts"],
    expectedFindings: [
      {
        path: "src/frontend/portal/api/apiService.ts",
        line: 81,
      },
    ],
  },
  {
    id: "portal-firebase-server-typed-user-conversion-clean",
    ruleId: "antidrift/no-appeasement-cast",
    kind: "correct",
    classification: "ready",
    subproject: "frontend",
    typeAware: true,
    tsconfig: "src/frontend/portal/tsconfig.json",
    paths: ["src/frontend/portal/lib/firebase/server.ts"],
  },
  {
    id: "monolith-firebase-obvious-get-comment",
    ruleId: "antidrift/no-obvious-comment",
    kind: "drift",
    classification: "ready",
    subproject: "frontend",
    paths: ["src/frontend/monolithui/src/lib/firebase.ts"],
    expectedFindings: [
      {
        path: "src/frontend/monolithui/src/lib/firebase.ts",
        line: 14,
      },
    ],
  },
  {
    id: "portal-latest-callback-ref-explanatory-doc-clean",
    ruleId: "antidrift/no-obvious-comment",
    kind: "correct",
    classification: "ready",
    subproject: "frontend",
    paths: ["src/frontend/portal/lib/hooks/useLatestCallbackRef.ts"],
  },
  {
    id: "crow-v2-theme-color-section-comments-clean",
    ruleId: "antidrift/no-obvious-comment",
    kind: "correct",
    classification: "ready",
    subproject: "frontend",
    paths: ["src/frontend/crow-v2/app/theme/colors.ts"],
  },
  {
    id: "monolith-qr-action-card-raw-fetch-helper",
    ruleId: "antidrift/no-raw-fetch-in-component",
    kind: "drift",
    classification: "ready",
    subproject: "frontend",
    paths: ["src/frontend/monolithui/src/components/QrActionsAdmin/QrActionCard.tsx"],
    expectedFindings: [
      {
        path: "src/frontend/monolithui/src/components/QrActionsAdmin/QrActionCard.tsx",
        line: 41,
      },
    ],
  },
  {
    id: "monolith-crowdies-api-raw-fetch-helper",
    ruleId: "antidrift/no-raw-fetch-in-component",
    kind: "correct",
    classification: "ready",
    subproject: "frontend",
    paths: ["src/frontend/monolithui/src/lib/crowdiesApi.ts"],
  },
  {
    id: "portal-impersonation-warning-raw-fetch-effect",
    ruleId: "antidrift/no-raw-fetch-in-component",
    kind: "drift",
    classification: "ready",
    subproject: "frontend",
    paths: ["src/frontend/portal/components/ImpersonationWarning.tsx"],
    expectedFindings: [
      {
        path: "src/frontend/portal/components/ImpersonationWarning.tsx",
        line: 85,
      },
    ],
  },
  {
    id: "portal-embedded-dashboard-clean-component",
    ruleId: "antidrift/no-raw-fetch-in-component",
    kind: "correct",
    classification: "ready",
    subproject: "frontend",
    paths: ["src/frontend/portal/components/EmbeddedDashboard.tsx"],
  },
  {
    id: "bff-scenario-planner-navigation-cycle",
    ruleId: "import-x/no-cycle",
    kind: "drift",
    classification: "ready",
    subproject: "bff",
    paths: ["src/frontend/bff/api/features/scenario-planner/core/navigation.ts"],
    ruleOptions: { "import-x/no-cycle": [{ ignoreExternal: true }] },
    expectedFindings: [
      {
        path: "src/frontend/bff/api/features/scenario-planner/core/navigation.ts",
        line: 6,
      },
    ],
  },
  {
    id: "monolith-crowdies-api-no-relative-cycle",
    ruleId: "import-x/no-cycle",
    kind: "correct",
    classification: "ready",
    subproject: "frontend",
    paths: ["src/frontend/monolithui/src/lib/crowdiesApi.ts"],
    ruleOptions: { "import-x/no-cycle": [{ ignoreExternal: true }] },
  },
  {
    id: "bff-google-maps-delayed-promise-all",
    ruleId: "antidrift/no-async-array-method",
    kind: "correct",
    classification: "ready",
    subproject: "bff",
    paths: ["src/frontend/bff/api/gateways/google-maps-gateway.ts"],
  },
  {
    id: "bff-scenarios-router-direct-promise-all-map-clean",
    ruleId: "antidrift/no-async-array-method",
    kind: "correct",
    classification: "ready",
    subproject: "bff",
    paths: ["src/frontend/bff/api/routers/scenarios-router.ts"],
  },
  {
    id: "bff-product-set-router-promise-all-settled-map-clean",
    ruleId: "antidrift/no-async-array-method",
    kind: "correct",
    classification: "ready",
    subproject: "bff",
    paths: ["src/frontend/bff/api/routers/product-set-router.ts"],
  },
  {
    id: "bff-retool-service-stop-promise-all-map-clean",
    ruleId: "antidrift/no-async-array-method",
    kind: "correct",
    classification: "ready",
    subproject: "bff",
    paths: ["src/frontend/bff/api/routers/retool/service-stop-router.ts"],
  },
  {
    id: "bff-orders-service-imported-proto-types-clean",
    ruleId: "antidrift/no-structural-type-fork",
    kind: "correct",
    classification: "under-proven",
    subproject: "bff",
    typeAware: true,
    ruleOptions: structuralTypeForkGeneratedOptions,
    paths: ["src/frontend/bff/api/services/orders-service.ts"],
  },
  {
    id: "bff-service-factory-client-alias-clean",
    ruleId: "antidrift/no-structural-type-fork",
    kind: "correct",
    classification: "ready",
    subproject: "bff",
    typeAware: true,
    ruleOptions: structuralTypeForkGeneratedOptions,
    paths: ["src/frontend/bff/api/services/service-factory.ts"],
  },
  {
    id: "bff-orders-ops-line-item-detail-generated-fork",
    ruleId: "antidrift/no-structural-type-fork",
    kind: "drift",
    classification: "ready",
    subproject: "bff",
    typeAware: true,
    ruleOptions: structuralTypeForkGeneratedOptions,
    paths: ["src/frontend/bff/api/routers/orders-ops-router.ts"],
    expectedFindings: [
      {
        path: "src/frontend/bff/api/routers/orders-ops-router.ts",
        line: 4059,
      },
    ],
  },
  {
    id: "bff-service-stop-line-item-counts-generated-fork",
    ruleId: "antidrift/no-structural-type-fork",
    kind: "drift",
    classification: "ready",
    subproject: "bff",
    typeAware: true,
    ruleOptions: structuralTypeForkGeneratedOptions,
    paths: ["src/frontend/bff/api/routers/retool/service-stop-router.ts"],
    expectedFindings: [
      {
        path: "src/frontend/bff/api/routers/retool/service-stop-router.ts",
        line: 103,
      },
    ],
  },
  {
    id: "portal-orchestration-types-compose-imported-bff-types-clean",
    ruleId: "antidrift/no-structural-type-fork",
    kind: "correct",
    classification: "under-proven",
    subproject: "frontend",
    typeAware: true,
    tsconfig: "src/frontend/portal/tsconfig.json",
    paths: ["src/frontend/portal/modules/Orchestration/plans/types/orchestration.ts"],
  },
  {
    id: "portal-route-assignments-local-range-tuple-clean",
    ruleId: "antidrift/no-structural-type-fork",
    kind: "correct",
    classification: "under-proven",
    subproject: "frontend",
    typeAware: true,
    tsconfig: "src/frontend/portal/tsconfig.json",
    paths: ["src/frontend/portal/modules/service-stop/route-assignments/types.ts"],
  },
  {
    id: "portal-route-assignments-nullable-custom-range-tuple",
    ruleId: "antidrift/no-nullable-positional-tuple",
    kind: "drift",
    classification: "ready",
    subproject: "frontend",
    typeAware: true,
    tsconfig: "src/frontend/portal/tsconfig.json",
    paths: ["src/frontend/portal/modules/service-stop/route-assignments/types.ts"],
    expectedFindings: [
      {
        path: "src/frontend/portal/modules/service-stop/route-assignments/types.ts",
        line: 6,
      },
    ],
  },
  {
    id: "crow-v2-counting-units-cases-coordinate-pair-clean",
    ruleId: "antidrift/no-nullable-positional-tuple",
    kind: "correct",
    classification: "ready",
    subproject: "frontend",
    paths: ["src/frontend/crow-v2/hooks/useCountingTasks.ts"],
  },
  {
    id: "portal-synced-map-viewstate-utility-type-clean",
    ruleId: "antidrift/no-structural-type-fork",
    kind: "correct",
    classification: "under-proven",
    subproject: "frontend",
    typeAware: true,
    tsconfig: "src/frontend/portal/tsconfig.json",
    paths: ["src/frontend/portal/modules/visualize-impact/tabs/total-savings/hooks/useSnycedMapsViewState.ts"],
  },
  {
    id: "portal-action-items-report-model-forks",
    ruleId: "antidrift/no-canonical-model-fork",
    kind: "drift",
    classification: "ready",
    subproject: "frontend",
    typeAware: true,
    tsconfig: "src/frontend/portal/tsconfig.json",
    ruleOptions: canonicalModelForkOptions,
    paths: ["src/frontend/portal/components/reports/action-items/types.ts"],
    expectedFindings: [
      {
        path: "src/frontend/portal/components/reports/action-items/types.ts",
        line: 10,
      },
      {
        path: "src/frontend/portal/components/reports/action-items/types.ts",
        line: 24,
      },
      {
        path: "src/frontend/portal/components/reports/action-items/types.ts",
        line: 42,
      },
    ],
  },
  {
    id: "portal-weekly-digest-report-models-clean",
    ruleId: "antidrift/no-canonical-model-fork",
    kind: "correct",
    classification: "ready",
    subproject: "frontend",
    typeAware: true,
    tsconfig: "src/frontend/portal/tsconfig.json",
    ruleOptions: canonicalModelForkOptions,
    paths: ["src/frontend/portal/components/reports/weekly-digest/types.ts"],
  },
  {
    id: "portal-report-model-owner-clean",
    ruleId: "antidrift/no-canonical-model-fork",
    kind: "correct",
    classification: "ready",
    subproject: "frontend",
    typeAware: true,
    tsconfig: "src/frontend/portal/tsconfig.json",
    ruleOptions: canonicalModelForkOptions,
    paths: ["src/frontend/portal/types/reports.ts"],
  },
  {
    id: "bff-bigquery-zod-boundary-parse-clean",
    ruleId: "antidrift/no-redundant-zod-parse",
    kind: "correct",
    classification: "ready",
    subproject: "bff",
    typeAware: true,
    paths: ["src/frontend/bff/api/gateways/bigquery-gateway.ts"],
  },
  {
    id: "bff-scenarios-zod-response-parse-clean",
    ruleId: "antidrift/no-redundant-zod-parse",
    kind: "correct",
    classification: "ready",
    subproject: "bff",
    typeAware: true,
    paths: ["src/frontend/bff/api/services/scenarios-service.ts"],
  },
  {
    id: "bff-sequence-count-router-redundant-zod-parse",
    ruleId: "antidrift/no-redundant-zod-parse",
    kind: "drift",
    classification: "ready",
    subproject: "bff",
    typeAware: true,
    paths: ["src/frontend/bff/api/routers/retool/sequence-count-router.ts"],
    expectedFindings: [
      {
        path: "src/frontend/bff/api/routers/retool/sequence-count-router.ts",
        line: 21,
      },
      {
        path: "src/frontend/bff/api/routers/retool/sequence-count-router.ts",
        line: 26,
      },
    ],
  },
  {
    id: "bff-erp-router-local-record-validation-clean",
    ruleId: "antidrift/no-redundant-zod-parse",
    kind: "correct",
    classification: "ready",
    subproject: "bff",
    typeAware: true,
    paths: ["src/frontend/bff/api/routers/retool/erp-router.ts"],
  },
  {
    id: "bff-posthog-schema-string-json-parse-clean",
    ruleId: "antidrift/no-unsafe-deserialize",
    kind: "correct",
    classification: "ready",
    subproject: "bff",
    typeAware: true,
    paths: ["src/frontend/bff/api/gateways/posthog-schema.ts"],
  },
  {
    id: "portal-impersonation-storage-json-parse-clean",
    ruleId: "antidrift/no-unsafe-deserialize",
    kind: "correct",
    classification: "ready",
    subproject: "frontend",
    typeAware: true,
    tsconfig: "src/frontend/portal/tsconfig.json",
    paths: ["src/frontend/portal/components/ImpersonationWarning.tsx"],
  },
  {
    id: "portal-customer-store-json-parse-safeparse-clean",
    ruleId: "antidrift/no-unsafe-deserialize",
    kind: "correct",
    classification: "ready",
    subproject: "frontend",
    typeAware: true,
    tsconfig: "src/frontend/portal/tsconfig.json",
    paths: ["src/frontend/portal/context/global/Customer/store.ts"],
  },
  {
    id: "portal-route-assignment-zod-json-transform-clean",
    ruleId: "antidrift/no-unsafe-deserialize",
    kind: "correct",
    classification: "ready",
    subproject: "frontend",
    typeAware: true,
    tsconfig: "src/frontend/portal/tsconfig.json",
    paths: ["src/frontend/portal/modules/service-stop/route-assignments/schemas.ts"],
  },
  {
    id: "bff-rep-progress-status-inline-union",
    ruleId: "antidrift/no-status-literal-in-type",
    kind: "drift",
    classification: "ready",
    subproject: "bff",
    paths: ["src/frontend/bff/api/routers/orders-ops-router.ts"],
    ruleOptions: {
      "antidrift/no-status-literal-in-type": [
        {
          statuses: {
            RepProgressStatus: {
              owner: "src/frontend/bff/api/routers/orders-ops-validation.ts",
              values: ["not_started", "in_progress", "at_stop", "traveling", "completed", "behind"],
            },
          },
        },
      ],
    },
    expectedFindings: [
      {
        path: "src/frontend/bff/api/routers/orders-ops-router.ts",
        line: 2133,
      },
    ],
  },
  {
    id: "bff-rep-progress-status-owner-clean",
    ruleId: "antidrift/no-status-literal-in-type",
    kind: "correct",
    classification: "ready",
    subproject: "bff",
    paths: ["src/frontend/bff/api/routers/orders-ops-validation.ts"],
    ruleOptions: {
      "antidrift/no-status-literal-in-type": [
        {
          statuses: {
            RepProgressStatus: {
              owner: "src/frontend/bff/api/routers/orders-ops-validation.ts",
              values: ["not_started", "in_progress", "at_stop", "traveling", "completed", "behind"],
            },
          },
        },
      ],
    },
  },
  {
    id: "portal-tag-variant-literals-not-status-clean",
    ruleId: "antidrift/no-status-literal-in-type",
    kind: "correct",
    classification: "ready",
    subproject: "frontend",
    paths: ["src/frontend/portal/components/Tag.tsx"],
    ruleOptions: {
      "antidrift/no-status-literal-in-type": [
        {
          statuses: {
            PlanStatus: {
              owner: "src/frontend/portal/modules/Orchestration/plans/types/orchestration.ts",
              values: [
                "active",
                "pending",
                "draft",
                "simulating",
                "simulation_success",
                "simulation_failed",
                "simulation_warning",
                "released_and_valid",
                "released_and_invalid",
                "past",
                "archived",
                "unknown",
              ],
            },
          },
        },
      ],
    },
  },
  {
    id: "portal-roles-enum-owner-clean",
    ruleId: "antidrift/no-role-literal-in-type",
    kind: "correct",
    classification: "under-proven",
    subproject: "frontend",
    paths: ["src/frontend/portal/api/types.ts"],
    ruleOptions: {
      "antidrift/no-role-literal-in-type": [
        {
          roles: {
            owner: "src/frontend/portal/api/types.ts",
            values: ["business-admin", "sales-manager", "sales-representative"],
          },
        },
      ],
    },
  },
  {
    id: "portal-user-form-role-enum-usage-clean",
    ruleId: "antidrift/no-role-literal-in-type",
    kind: "correct",
    classification: "under-proven",
    subproject: "frontend",
    paths: ["src/frontend/portal/modules/UserForm/constants.ts"],
    ruleOptions: {
      "antidrift/no-role-literal-in-type": [
        {
          roles: {
            owner: "src/frontend/portal/api/types.ts",
            values: ["business-admin", "sales-manager", "sales-representative"],
          },
        },
      ],
    },
  },
  {
    id: "portal-user-form-role-type-import-clean",
    ruleId: "antidrift/no-role-literal-in-type",
    kind: "correct",
    classification: "under-proven",
    subproject: "frontend",
    paths: ["src/frontend/portal/modules/UserForm/types.ts"],
    ruleOptions: {
      "antidrift/no-role-literal-in-type": [
        {
          roles: {
            owner: "src/frontend/portal/api/types.ts",
            values: ["business-admin", "sales-manager", "sales-representative"],
          },
        },
      ],
    },
  },
  {
    id: "bff-jwt-role-claim-keys-clean",
    ruleId: "antidrift/no-role-literal-in-type",
    kind: "correct",
    classification: "under-proven",
    subproject: "bff",
    paths: ["src/frontend/bff/api/helpers/jwt.ts"],
    ruleOptions: {
      "antidrift/no-role-literal-in-type": [
        {
          roles: {
            owner: "src/frontend/portal/api/types.ts",
            values: ["business-admin", "sales-manager", "sales-representative"],
          },
        },
      ],
    },
  },
  {
    id: "monolith-user-onboarding-runtime-role-strings-clean",
    ruleId: "antidrift/no-role-literal-in-type",
    kind: "correct",
    classification: "under-proven",
    subproject: "frontend",
    paths: ["src/frontend/monolithui/src/components/UserOnboarding.tsx"],
    ruleOptions: {
      "antidrift/no-role-literal-in-type": [
        {
          roles: {
            owner: "src/frontend/portal/api/types.ts",
            values: ["business-admin", "sales-manager", "sales-representative"],
          },
        },
      ],
    },
  },
  {
    id: "portal-users-table-direct-posthog-import",
    ruleId: "no-restricted-imports",
    kind: "drift",
    classification: "ready",
    subproject: "frontend",
    paths: ["src/frontend/portal/modules/UsersTable/hooks/useUsersTable.ts"],
    ruleOptions: {
      "no-restricted-imports": [
        {
          patterns: [{ group: ["posthog-js", "posthog-js/**"], message: "Import through the approved gateway wrapper." }],
        },
      ],
    },
    expectedFindings: [
      {
        path: "src/frontend/portal/modules/UsersTable/hooks/useUsersTable.ts",
        line: 10,
      },
    ],
  },
  {
    id: "portal-posthog-analytics-wrapper-clean",
    ruleId: "no-restricted-imports",
    kind: "correct",
    classification: "ready",
    subproject: "frontend",
    paths: ["src/frontend/portal/context/global/PostHog/analytics.ts"],
    ruleOptions: {
      "no-restricted-imports": [
        {
          patterns: [{ group: ["posthog-js", "posthog-js/**"], message: "Import through the approved gateway wrapper." }],
        },
      ],
    },
    extraOverrideConfig: [
      {
        files: ["src/frontend/portal/context/global/PostHog/analytics.ts"],
        rules: { "no-restricted-imports": "off" },
      },
    ],
  },
  {
    id: "bff-scenarios-service-inline-request-contracts",
    ruleId: "antidrift/no-inline-structural-type-at-use-site",
    kind: "drift",
    classification: "ready",
    subproject: "bff",
    paths: ["src/frontend/bff/api/services/scenarios-service.ts"],
    expectedFindings: [
      {
        path: "src/frontend/bff/api/services/scenarios-service.ts",
        line: 332,
      },
    ],
  },
  {
    id: "monolith-auth-provider-inline-react-props-clean",
    ruleId: "antidrift/no-inline-structural-type-at-use-site",
    kind: "correct",
    classification: "ready",
    subproject: "frontend",
    paths: ["src/frontend/monolithui/src/providers/AuthProvider.tsx"],
  },
  {
    id: "monolith-change-delivery-callback-shape-clean",
    ruleId: "antidrift/no-inline-structural-type-at-use-site",
    kind: "correct",
    classification: "ready",
    subproject: "frontend",
    paths: ["src/frontend/monolithui/src/components/Orders/ChangeDeliveryDateDialog.tsx"],
  },
  {
    id: "monolith-crowops-bare-hook-disable",
    ruleId: "@eslint-community/eslint-comments/require-description",
    kind: "drift",
    classification: "ready",
    subproject: "frontend",
    paths: ["src/frontend/monolithui/src/components/CrowOps/CrowOps.tsx"],
    expectedFindings: [
      {
        path: "src/frontend/monolithui/src/components/CrowOps/CrowOps.tsx",
        line: 178,
      },
    ],
  },
  {
    id: "portal-accounts-ts-expect-error-reason-clean",
    ruleId: "@eslint-community/eslint-comments/require-description",
    kind: "correct",
    classification: "ready",
    subproject: "frontend",
    paths: ["src/frontend/portal/modules/Accounts/Accounts.tsx"],
  },
  {
    id: "portal-weekly-digest-jsx-ts-expect-error-reason-clean",
    ruleId: "@eslint-community/eslint-comments/require-description",
    kind: "correct",
    classification: "ready",
    subproject: "frontend",
    paths: ["src/frontend/portal/components/reports/weekly-digest/Reports.tsx"],
  },
  {
    id: "bff-posthog-interpolated-hogql",
    ruleId: "antidrift/no-sql-string-concat",
    kind: "drift",
    classification: "ready",
    subproject: "bff",
    paths: ["src/frontend/bff/api/gateways/posthog-gateway.ts"],
    expectedFindings: [
      {
        path: "src/frontend/bff/api/gateways/posthog-gateway.ts",
        line: 570,
      },
    ],
  },
  {
    id: "bff-bigquery-parameterized-query-clean",
    ruleId: "antidrift/no-sql-string-concat",
    kind: "correct",
    classification: "ready",
    subproject: "bff",
    paths: ["src/frontend/bff/api/gateways/bigquery-gateway.ts"],
  },
  {
    id: "portal-total-savings-coupled-timeframe-state",
    ruleId: "antidrift/no-coupled-state-setters",
    kind: "drift",
    classification: "ready",
    subproject: "frontend",
    paths: ["src/frontend/portal/modules/visualize-impact/tabs/total-savings/total-savings.tsx"],
    expectedFindings: [
      {
        path: "src/frontend/portal/modules/visualize-impact/tabs/total-savings/total-savings.tsx",
        line: 103,
      },
    ],
  },
  {
    id: "monolith-sequence-ops-coupled-state-clean",
    ruleId: "antidrift/no-coupled-state-setters",
    kind: "correct",
    classification: "ready",
    subproject: "frontend",
    paths: ["src/frontend/monolithui/src/components/SequenceOps.tsx"],
  },
  {
    id: "crow-v2-team-members-status-triplet",
    ruleId: "antidrift/no-status-triplet-state",
    kind: "drift",
    classification: "ready",
    subproject: "frontend",
    paths: ["src/frontend/crow-v2/hooks/useTeamMembers.ts"],
    expectedFindings: [
      {
        path: "src/frontend/crow-v2/hooks/useTeamMembers.ts",
        line: 33,
      },
    ],
  },
  {
    id: "monolith-products-query-state-clean",
    ruleId: "antidrift/no-status-triplet-state",
    kind: "correct",
    classification: "ready",
    subproject: "frontend",
    paths: ["src/frontend/monolithui/src/components/Products.tsx"],
  },
  {
    id: "portal-inventory-raw-tailwind-color",
    ruleId: "antidrift/no-raw-tailwind-color",
    kind: "drift",
    classification: "ready",
    subproject: "frontend",
    paths: ["src/frontend/portal/modules/InventoryInMarket/InventoryInMarket.tsx"],
    expectedFindings: [
      {
        path: "src/frontend/portal/modules/InventoryInMarket/InventoryInMarket.tsx",
        line: 35,
      },
    ],
  },
  {
    id: "monolith-products-no-raw-tailwind-color",
    ruleId: "antidrift/no-raw-tailwind-color",
    kind: "correct",
    classification: "ready",
    subproject: "frontend",
    paths: ["src/frontend/monolithui/src/components/Products.tsx"],
  },
  {
    id: "monolith-category-nav-hover-color-no-translate-clean",
    ruleId: "antidrift/no-hover-translate-card",
    kind: "correct",
    classification: "ready",
    subproject: "frontend",
    paths: ["src/frontend/monolithui/src/components/SolverConfig/CategoryNav.tsx"],
  },
  {
    id: "monolith-find-my-rep-hover-scale-no-translate-clean",
    ruleId: "antidrift/no-hover-translate-card",
    kind: "correct",
    classification: "ready",
    subproject: "frontend",
    paths: ["src/frontend/monolithui/src/components/FindMyRep.tsx"],
  },
  {
    id: "portal-visualize-tabs-active-indicator-translate-clean",
    ruleId: "antidrift/no-hover-translate-card",
    kind: "correct",
    classification: "ready",
    subproject: "frontend",
    paths: ["src/frontend/portal/modules/visualize-impact/components/visualize-impact-tabs.tsx"],
  },
  {
    id: "portal-agent-table-nested-selector-wrapper",
    ruleId: "antidrift/no-trivial-selector-wrapper",
    kind: "drift",
    classification: "ready",
    subproject: "frontend",
    paths: ["src/frontend/portal/modules/scenarios/agent-configuration/components/table/use-agent-table-data.ts"],
    expectedFindings: [
      {
        path: "src/frontend/portal/modules/scenarios/agent-configuration/components/table/use-agent-table-data.ts",
        line: 15,
      },
    ],
  },
  {
    id: "portal-service-time-nested-selector-wrapper",
    ruleId: "antidrift/no-trivial-selector-wrapper",
    kind: "drift",
    classification: "ready",
    subproject: "frontend",
    paths: ["src/frontend/portal/modules/scenarios/service-time-influence/components/table/service-time-influence-table.tsx"],
    expectedFindings: [
      {
        path: "src/frontend/portal/modules/scenarios/service-time-influence/components/table/service-time-influence-table.tsx",
        line: 39,
      },
    ],
  },
  {
    id: "bff-header-helper-selector-clean",
    ruleId: "antidrift/no-trivial-selector-wrapper",
    kind: "correct",
    classification: "ready",
    subproject: "bff",
    paths: ["src/frontend/bff/api/services/helpers.ts"],
  },
  {
    id: "portal-account-formatters-selector-clean",
    ruleId: "antidrift/no-trivial-selector-wrapper",
    kind: "correct",
    classification: "ready",
    subproject: "frontend",
    paths: ["src/frontend/portal/modules/Accounts/formatters.ts"],
  },
  {
    id: "bff-scenarios-global-params-shape-probing",
    ruleId: "antidrift/no-defensive-shape-probing",
    kind: "drift",
    classification: "ready",
    subproject: "bff",
    typeAware: true,
    paths: ["src/frontend/bff/api/services/scenarios-service.ts"],
    expectedFindings: [
      {
        path: "src/frontend/bff/api/services/scenarios-service.ts",
        line: 706,
      },
    ],
  },
  {
    id: "bff-date-message-type-predicate-clean",
    ruleId: "antidrift/no-defensive-shape-probing",
    kind: "correct",
    classification: "ready",
    subproject: "bff",
    typeAware: true,
    paths: ["src/frontend/bff/shared/date.ts"],
  },
  {
    id: "bff-bigquery-zod-normalization-clean",
    ruleId: "antidrift/no-defensive-shape-probing",
    kind: "correct",
    classification: "ready",
    subproject: "bff",
    typeAware: true,
    paths: ["src/frontend/bff/api/gateways/bigquery-gateway.ts"],
  },
  {
    id: "bff-optimizer-config-value-type-clean",
    ruleId: "antidrift/no-defensive-shape-probing",
    kind: "correct",
    classification: "ready",
    subproject: "bff",
    typeAware: true,
    paths: ["src/frontend/bff/api/schemas/optimizer-config.ts"],
  },
  {
    id: "bff-service-stop-retool-line-item-underchecked-predicate",
    ruleId: "antidrift/no-underchecked-type-predicate",
    kind: "drift",
    classification: "ready",
    subproject: "bff",
    typeAware: true,
    paths: ["src/frontend/bff/api/routers/retool/service-stop-router.ts"],
    expectedFindings: [
      {
        path: "src/frontend/bff/api/routers/retool/service-stop-router.ts",
        line: 394,
      },
    ],
  },
  {
    id: "bff-date-message-field-checked-predicate-clean",
    ruleId: "antidrift/no-underchecked-type-predicate",
    kind: "correct",
    classification: "ready",
    subproject: "bff",
    typeAware: true,
    paths: ["src/frontend/bff/shared/date.ts"],
  },
  {
    id: "bff-powersync-discriminant-predicates-clean",
    ruleId: "antidrift/no-underchecked-type-predicate",
    kind: "correct",
    classification: "ready",
    subproject: "bff",
    typeAware: true,
    paths: ["src/frontend/bff/api/schemas/powersync.ts"],
  },
  {
    id: "monolith-account-details-destructured-date-predicate-clean",
    ruleId: "antidrift/no-underchecked-type-predicate",
    kind: "correct",
    classification: "ready",
    subproject: "frontend",
    typeAware: true,
    tsconfig: "src/frontend/monolithui/tsconfig.json",
    paths: ["src/frontend/monolithui/src/components/AccountDetails.tsx"],
  },
  {
    id: "portal-latest-callback-ref-missing-layout-effect-deps",
    ruleId: "antidrift/require-effect-deps",
    kind: "drift",
    classification: "ready",
    subproject: "frontend",
    paths: ["src/frontend/portal/lib/hooks/useLatestCallbackRef.ts"],
    expectedFindings: [
      {
        path: "src/frontend/portal/lib/hooks/useLatestCallbackRef.ts",
        line: 26,
      },
    ],
  },
  {
    id: "portal-debounce-effect-deps-clean",
    ruleId: "antidrift/require-effect-deps",
    kind: "correct",
    classification: "ready",
    subproject: "frontend",
    paths: ["src/frontend/portal/lib/hooks/useDebounce.ts"],
  },
  {
    id: "portal-sticky-column-layout-effect-deps-clean",
    ruleId: "antidrift/require-effect-deps",
    kind: "correct",
    classification: "ready",
    subproject: "frontend",
    paths: ["src/frontend/portal/modules/scenarios/hooks/use-sticky-column-offsets.ts"],
  },
  {
    id: "monolith-sequence-ops-effect-deps-clean",
    ruleId: "antidrift/require-effect-deps",
    kind: "correct",
    classification: "ready",
    subproject: "frontend",
    paths: ["src/frontend/monolithui/src/components/SequenceOps.tsx"],
  },
];

function parseCsv(value) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function normalizeRuleId(rule) {
  if (rule.includes("/")) return rule;
  if (coreRuleIds.has(rule)) return rule;
  return `antidrift/${rule}`;
}

function parseArgs(argv) {
  const out = { repo: null, slice: "chaski-corpus", output: null, require: false, rules: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--repo" && next) {
      out.repo = next;
      i += 1;
    } else if (arg === "--slice" && next) {
      out.slice = next;
      i += 1;
    } else if (arg === "--output" && next) {
      out.output = next;
      i += 1;
    } else if (arg === "--rules" && next) {
      out.rules = parseCsv(next).map(normalizeRuleId);
      i += 1;
    } else if (arg === "--require") {
      out.require = true;
    }
  }
  return out;
}

function findRepoRoot(repo, repoCandidates = defaultRepoCandidates) {
  const candidates = repo ? [repo] : repoCandidates;
  return candidates.map((candidate) => resolve(candidate)).find((candidate) => existsSync(candidate)) ?? null;
}

function relativeFile(repoRoot, filePath) {
  return relative(repoRoot, filePath).replace(/\\/gu, "/");
}

function ruleValueFor(testCase) {
  const options = testCase.ruleOptions?.[testCase.ruleId];
  return options ? ["error", ...options] : ["error"];
}

function typeAwareProjectFor(testCase) {
  if (!testCase.typeAware) return null;
  return testCase.tsconfig ?? defaultTypeAwareProjects[testCase.subproject] ?? null;
}

function parserOptionsFor(repoRoot, testCase) {
  const project = typeAwareProjectFor(testCase);
  if (!project) return { ecmaFeatures: { jsx: true } };
  return {
    ecmaFeatures: { jsx: true },
    project: [project],
    tsconfigRootDir: repoRoot,
  };
}

function expectedFindingPresent(findings, expected) {
  return findings.some((finding) => finding.path === expected.path && finding.line === expected.line);
}

function evaluateCase(testCase, findings, missingFiles, corpusLabel = "corpus") {
  if (missingFiles.length > 0) {
    return { decision: "fail", reason: `Missing ${corpusLabel} files: ${missingFiles.join(", ")}` };
  }

  if (testCase.kind === "correct" && findings.length > 0) {
    return { decision: "fail", reason: `Expected clean ${corpusLabel} source, but the rule reported findings.` };
  }

  if (testCase.kind === "drift") {
    if (findings.length === 0) {
      return { decision: "fail", reason: `Expected ${corpusLabel} drift finding, but the rule stayed silent.` };
    }
    for (const expected of testCase.expectedFindings ?? []) {
      if (!expectedFindingPresent(findings, expected)) {
        return { decision: "fail", reason: `Expected finding at ${expected.path}:${expected.line}.` };
      }
    }
  }

  return { decision: "pass", reason: null };
}

async function lintCase(repoRoot, testCase, corpusLabel) {
  const absolutePaths = testCase.paths.map((path) => resolve(repoRoot, path));
  const typeAwareProject = typeAwareProjectFor(testCase);
  const requiredPaths = typeAwareProject ? [...absolutePaths, resolve(repoRoot, typeAwareProject)] : absolutePaths;
  const missingFiles = requiredPaths.filter((path) => !existsSync(path)).map((path) => relativeFile(repoRoot, path));
  if (missingFiles.length > 0) {
    return {
      id: testCase.id,
      ruleId: testCase.ruleId,
      kind: testCase.kind,
      classification: testCase.classification,
      subproject: testCase.subproject,
      paths: testCase.paths,
      findings: [],
      missingFiles,
      decision: "fail",
      reason: `Missing ${corpusLabel} files: ${missingFiles.join(", ")}`,
    };
  }

  const eslint = new ESLint({
    cwd: repoRoot,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ["**/*.{ts,tsx,js,jsx}"],
        ignores: ["**/node_modules/**", "**/dist/**", "**/build/**", "**/gen/**"],
        languageOptions: {
          parser: tsParser,
          ecmaVersion: 2023,
          sourceType: "module",
          parserOptions: parserOptionsFor(repoRoot, testCase),
        },
        plugins: { antidrift: plugin, "@eslint-community/eslint-comments": eslintComments, "import-x": importX },
        settings: {
          "import-x/extensions": [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
          "import-x/resolver": {
            node: { extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] },
          },
        },
        rules: { [testCase.ruleId]: ruleValueFor(testCase) },
      },
      ...(testCase.extraOverrideConfig ?? []),
    ],
  });

  const results = await eslint.lintFiles(absolutePaths);
  const findings = results.flatMap((result) =>
    result.messages
      .filter((message) => message.ruleId === testCase.ruleId)
      .map((message) => ({
        path: relativeFile(repoRoot, result.filePath),
        ruleId: message.ruleId,
        line: message.line,
        column: message.column,
        message: message.message,
      }))
  );
  const evaluation = evaluateCase(testCase, findings, missingFiles, corpusLabel);

  return {
    id: testCase.id,
    ruleId: testCase.ruleId,
    kind: testCase.kind,
    classification: testCase.classification,
    subproject: testCase.subproject,
    paths: testCase.paths,
    findings,
    missingFiles,
    ...evaluation,
  };
}

export async function runCorpusCases({
  corpus = "corpus",
  corpusLabel = corpus,
  repoCandidates = defaultRepoCandidates,
  repo = null,
  slice = `${corpus}-corpus`,
  output = null,
  require = false,
  rules = null,
  cases = defaultCases,
  report = console.log,
} = {}) {
  const repoRoot = findRepoRoot(repo, repoCandidates);
  if (!repoRoot) {
    const summary = {
      schemaVersion: 1,
      corpus,
      slice,
      decision: require ? "fail" : "skip",
      reason: `${corpusLabel} repo not found. Pass --repo or set the matching environment variable.`,
      cases: [],
    };
    report(JSON.stringify(summary, null, 2));
    return summary;
  }

  const selectedCases = rules ? cases.filter((testCase) => rules.includes(testCase.ruleId)) : cases;
  if (selectedCases.length === 0) {
    const summary = {
      schemaVersion: 1,
      corpus,
      slice,
      repoRoot,
      decision: require ? "fail" : "skip",
      reason: "No corpus cases matched the requested rules.",
      rules: [],
      cases: [],
    };
    const json = `${JSON.stringify(summary, null, 2)}\n`;
    if (output) {
      writeFileSync(resolve(output), json, "utf8");
    } else {
      report(json.trimEnd());
    }
    return summary;
  }
  const results = await Promise.all(selectedCases.map((testCase) => lintCase(repoRoot, testCase, corpusLabel)));

  const summary = {
    schemaVersion: 1,
    corpus,
    slice,
    repoRoot,
    decision: results.some((result) => result.decision !== "pass") ? "fail" : "pass",
    rules: [...new Set(selectedCases.map((testCase) => testCase.ruleId))],
    cases: results,
  };
  const json = `${JSON.stringify(summary, null, 2)}\n`;
  if (output) {
    writeFileSync(resolve(output), json, "utf8");
  } else {
    report(json.trimEnd());
  }
  return summary;
}

export async function chaskiCorpus(options = {}) {
  return runCorpusCases({
    corpus: "chaski",
    corpusLabel: "Chaski",
    repoCandidates: defaultRepoCandidates,
    slice: "chaski-corpus",
    cases: defaultCases,
    ...options,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await chaskiCorpus(parseArgs(process.argv.slice(2)));
  if (result.decision === "fail") process.exitCode = 1;
}

export { parseArgs };
