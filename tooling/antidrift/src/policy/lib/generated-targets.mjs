export const generatedTargets = [
  "AGENTS.md",
  "CLAUDE.md",
  ".github/copilot-instructions.md",
  ".cursor/rules/architecture.mdc",
  ".cursor/rules/react-state.mdc",
  ".cursor/rules/type-contracts.mdc",
  ".cursor/rules/policy-files.mdc",
  ".claude/settings.json",
  ".codex/hooks.json",
  ".oxlintrc.json",
];

export const protectedPolicyFiles = [
  ...generatedTargets,
  "policy/agent-guardrails.yaml",
  "eslint.config.mjs",
  "tsconfig.base.json",
  "tsconfig.json",
  "sonar-project.properties",
  ".github/workflows/check.yml",
  "pnpm-workspace.yaml",
];
