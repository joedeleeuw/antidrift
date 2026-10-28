const generatedTargets = [
  "AGENTS.md",
  "CLAUDE.md",
  ".github/copilot-instructions.md",
  ".claude/settings.json",
  ".codex/hooks.json",
];

export const protectedPolicyFiles = [
  ...generatedTargets,
  "policy/agent-guardrails.yaml",
  "eslint-suppressions.json",
  "oxlint.config.mts",
  "tsconfig.base.json",
  "tsconfig.json",
  "sonar-project.properties",
  ".github/workflows/check.yml",
  "pnpm-workspace.yaml",
];
