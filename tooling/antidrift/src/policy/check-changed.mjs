import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { changedFiles } from "./lib/git.mjs";
import { protectedPolicyFiles } from "./lib/generated-targets.mjs";

export function checkChanged() {
  const changed = changedFiles();
  const codeFiles = changed.filter((file) => /\.(js|mjs|cjs|ts|tsx)$/u.test(file));
  const protectedChanged = changed.filter((file) => protectedPolicyFiles.includes(file));
  const policyChanged = changed.includes("policy/agent-guardrails.yaml");

  if (protectedChanged.length > 0 && !policyChanged && !process.env.POLICY_CHANGE) {
    console.error("Protected policy/config files changed without policy source update:");
    for (const file of protectedChanged) console.error(`- ${file}`);
    console.error("Edit policy/agent-guardrails.yaml and run pnpm policy:generate, or set POLICY_CHANGE=1 for an explicit policy task.");
    process.exit(1);
  }

  if (codeFiles.length === 0) {
    console.log("No changed JS/TS files to check.");
    return;
  }

  const commands = [
    ["pnpm", ["exec", "oxlint", ...codeFiles, "--deny-warnings"]],
    ["pnpm", ["exec", "eslint", ...codeFiles, "--max-warnings", "0"]],
  ];

  for (const [command, args] of commands) {
    const result = spawnSync(command, args, { stdio: "inherit" });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  checkChanged();
}
