import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

const hookScript = (name) =>
  `node node_modules/@joedeleeuw/antidrift/src/policy/hooks/${name}.mjs`;

async function write(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

export function renderPolicyArtifacts(policy) {
  const clusterLines = policy.clusters
    .map((cluster) => ({
      id: cluster.id,
      owner: cluster.owner,
      rules: cluster.rules
        .filter((rule) => rule.severity !== "off")
        .map((rule) => rule.id),
    }))
    .filter((cluster) => cluster.rules.length > 0)
    .map(
      (cluster) =>
        `- **${cluster.id}** (${cluster.owner}): ${cluster.rules.join(", ")}`
    )
    .join("\n");
  const header =
    "This file is generated from `policy/agent-guardrails.yaml`. Do not edit it directly.";
  const neverLines = [
    "Do not edit generated policy artifacts directly.",
    "Do not weaken lint/type/test/CI/Sonar/hook configuration unless the task includes `[policy-change]`.",
    "Do not add type escape hatches, silent catches, focused tests, or cross-layer imports.",
    ...(Array.isArray(policy.meta?.never) ? policy.meta.never : []),
  ]
    .map((rule) => `- ${rule}`)
    .join("\n");

  const artifacts = new Map();
  artifacts.set(
    "AGENTS.md",
    `# Repository Agent Instructions\n\n${header}\n\n## Required checks\n\nRun \`pnpm policy:verify-session\` before pushing.\n\n## Never\n\n${neverLines}\n\n## Rule clusters\n\n${clusterLines}\n`
  );

  artifacts.set(
    "CLAUDE.md",
    `# Claude Project Instructions\n\n${header}\n\nTreat hooks and deterministic checks as authoritative. Fix code instead of weakening policy.\n\n## Required checks\n\nRun \`pnpm policy:verify-session\` before pushing.\n\n## Rule clusters\n\n${clusterLines}\n`
  );

  artifacts.set(
    ".github/copilot-instructions.md",
    `# Copilot Instructions\n\n${header}\n\nFollow repository architecture boundaries, avoid type escape hatches, and use public package APIs.\n`
  );

  const hooks = {
    PreToolUse: [
      {
        matcher: "Edit|Write|MultiEdit",
        hooks: [
          {
            type: "command",
            command: hookScript("block-generated-policy-edits"),
          },
        ],
      },
    ],
    PostToolUse: [
      {
        matcher: "Edit|Write|MultiEdit",
        hooks: [{ type: "command", command: "pnpm policy:check:changed" }],
      },
    ],
  };

  artifacts.set(
    ".claude/settings.json",
    JSON.stringify({ hooks }, null, 2) + "\n"
  );
  artifacts.set(".codex/hooks.json", JSON.stringify({ hooks }, null, 2) + "\n");
  return artifacts;
}

export async function loadPolicy(policyPath = "policy/agent-guardrails.yaml") {
  const policyText = await readFile(policyPath, "utf8");
  return YAML.parse(policyText);
}

export async function generate() {
  const artifacts = renderPolicyArtifacts(await loadPolicy());
  await Promise.all(
    [...artifacts].map(([path, content]) => write(path, content))
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await generate();
}
