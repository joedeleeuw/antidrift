import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import oxlintConfig from "../oxlint-config/index.mjs";

const hookScript = (name) => `node node_modules/@joedeleeuw/antidrift/src/policy/hooks/${name}.mjs`;

async function write(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

export async function generate() {
  const policyText = await readFile("policy/agent-guardrails.yaml", "utf8");
  const policy = YAML.parse(policyText);
  const clusterLines = policy.clusters.map((cluster) => `- **${cluster.id}** (${cluster.owner}): ${cluster.rules.map((rule) => rule.id).join(", ")}`).join("\n");
  const header = "This file is generated from `policy/agent-guardrails.yaml`. Do not edit it directly.";

  await write("AGENTS.md", `# Repository Agent Instructions\n\n${header}\n\n## Required checks\n\nRun \`pnpm policy:verify-session\` before finishing substantial code work.\n\n## Never\n\n- Do not edit generated policy artifacts directly.\n- Do not weaken lint/type/test/CI/Sonar/hook configuration unless the task includes \`[policy-change]\`.\n- Do not add type escape hatches, silent catches, focused tests, raw component fetches, or cross-layer imports.\n\n## Rule clusters\n\n${clusterLines}\n`);

  await write("CLAUDE.md", `# Claude Project Instructions\n\n${header}\n\nTreat hooks and deterministic checks as authoritative. Fix code instead of weakening policy.\n\n## Stop condition\n\nRun \`pnpm policy:verify-session\` before stopping.\n\n## Rule clusters\n\n${clusterLines}\n`);

  await write(".github/copilot-instructions.md", `# Copilot Instructions\n\n${header}\n\nFollow repository architecture boundaries, avoid type escape hatches, and use public package APIs.\n`);

  await write(".cursor/rules/architecture.mdc", `---\ndescription: Enforce architecture boundaries and prevent semantic drift.\nglobs: ["apps/**/*.ts", "apps/**/*.tsx", "packages/**/*.ts", "packages/**/*.tsx"]\nalwaysApply: true\n---\n\n${header}\n\nUse public package entrypoints and preserve architecture direction.\n`);

  await write(".cursor/rules/react-state.mdc", `---\ndescription: Prevent React state-shape slop from agent-generated UI.\nglobs: ["apps/**/*.tsx", "packages/ui/**/*.tsx"]\nalwaysApply: true\n---\n\n${header}\n\nAvoid coupled useState waterfalls, status triplets, derived-state effects, and raw fetch calls in components.\n`);

  await write(".cursor/rules/type-contracts.mdc", `---\ndescription: Prevent local TypeScript appeasement patterns.\nglobs: ["apps/**/*.{ts,tsx}", "packages/**/*.{ts,tsx}"]\nalwaysApply: true\n---\n\n${header}\n\nDo not create typed selector wrappers, one-use aliases, inline structural contracts, or unsafe cast chains.\n`);

  await write(".cursor/rules/policy-files.mdc", `---\ndescription: Protect generated policy artifacts from direct edits.\nglobs: ["AGENTS.md", "CLAUDE.md", ".cursor/rules/*.mdc", ".claude/settings.json", ".codex/hooks.json", ".github/copilot-instructions.md"]\nalwaysApply: true\n---\n\n${header}\n\nEdit the source policy and run \`pnpm policy:generate\`.\n`);

  const hooks = {
    PreToolUse: [
      { matcher: "Edit|Write|MultiEdit", hooks: [{ type: "command", command: hookScript("block-generated-policy-edits") }] },
      { matcher: "Bash", hooks: [{ type: "command", command: hookScript("block-dangerous-shell") }] }
    ],
    PostToolUse: [
      { matcher: "Edit|Write|MultiEdit", hooks: [{ type: "command", command: "pnpm policy:check:changed" }] }
    ],
    Stop: [
      { hooks: [{ type: "command", command: "pnpm policy:verify-session" }] }
    ]
  };

  await write(".claude/settings.json", JSON.stringify({ hooks }, null, 2) + "\n");
  await write(".codex/hooks.json", JSON.stringify(hooks, null, 2) + "\n");

  // Oxlint reads JSON, not our JS module, so the shared baseline is emitted as `.oxlintrc.json`
  // (which Oxlint auto-discovers). Source of truth is src/oxlint-config/index.mjs.
  await write(".oxlintrc.json", JSON.stringify(oxlintConfig, null, 2) + "\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await generate();
}
