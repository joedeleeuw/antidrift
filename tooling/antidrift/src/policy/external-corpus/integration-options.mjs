import { resolve } from "node:path";
import { homedir } from "node:os";

export const integrationRepoCandidates = {
  codebaseAtlas: [
    process.env.CODEBASE_ATLAS_REPO,
    resolve(homedir(), "code", "codebase-atlas"),
  ].filter(Boolean),
  murderbox: [
    process.env.MURDERBOX_REPO,
    resolve(homedir(), "code", "murderbox"),
  ].filter(Boolean),
  cloudflareAgents: [
    process.env.CLOUDFLARE_AGENTS_REPO,
    resolve(homedir(), "code", "cloudflare-agents"),
  ].filter(Boolean),
  claudeCodeSource: [
    process.env.CLAUDE_CODE_SOURCE_REPO,
    resolve(homedir(), "code", "claude-code-src-code"),
    resolve(homedir(), "code", "claude-code-source-code"),
  ].filter(Boolean),
  opencode: [
    process.env.OPENCODE_REPO,
    resolve(homedir(), "code", "opencode"),
  ].filter(Boolean),
  dotfiles: [
    process.env.DOTFILES_REPO,
    resolve(homedir(), "code", "dotfiles"),
  ].filter(Boolean),
  powersyncService: [
    process.env.POWERSYNC_SERVICE_REPO,
    resolve(homedir(), "code", "powersync-service"),
  ].filter(Boolean),
  xaiSdkTs: [
    process.env.XAI_SDK_TS_REPO,
    resolve(homedir(), "code", "xai-sdk-ts"),
  ].filter(Boolean),
  letraz: [
    process.env.LETRAZ_REPO,
    resolve(homedir(), "code", "letraz"),
  ].filter(Boolean),
  neblir: [
    process.env.NEBLIR_REPO,
    resolve(homedir(), "code", "neblir"),
  ].filter(Boolean),
  lightdash: [
    process.env.LIGHTDASH_REPO,
    resolve(homedir(), "code", "lightdash"),
  ].filter(Boolean),
  reflet: [
    process.env.REFLET_REPO,
    resolve(homedir(), "code", "reflet"),
  ].filter(Boolean),
};

export const powersyncSqlRuleOptions = {
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
export const cloudflareAgentsSqlRuleOptions = {
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
export const opencodeSqlRuleOptions = {
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
