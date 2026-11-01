import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";
import { z } from "zod";

import { NATIVE_ARTIFACTS, resolveNativeArtifact } from "./oxlint.mjs";

const hookScript = (name) => `pnpm exec antidrift hook ${name}`;

async function write(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

const POLICY_HEADER =
  "This file is generated from `policy/agent-guardrails.yaml` and the Rust rule levels in `Cargo.toml`. Do not edit it directly.";

const AGENT_HOOKS = {
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

function clusterLinesFor(clusters) {
  return clusters
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
}

const rustRuleSchema = z.array(
  z.object({
    id: z.string(),
    kind: z.enum(["general", "house-style"]),
    scopePolicy: z.enum([
      "everywhere",
      "except-generated",
      "authored-source",
      "non-example-source",
      "non-script-entry",
      "shared-only",
      "test-files-only",
    ]),
    level: z.enum(["error", "warn", "off"]),
    guidance: z.string(),
    lineCap: z.object({ warnAbove: z.number(), max: z.number() }).optional(),
  })
);

const cargoArtifactSchema = z.object({
  reason: z.string(),
  target: z.object({ name: z.string() }).optional(),
  executable: z.string().nullable().optional(),
});

function buildWorkspaceLinter(cwd) {
  let output;
  try {
    output = execFileSync(
      "cargo",
      [
        "build",
        "--locked",
        "-p",
        "antidrift-linter",
        "--message-format=json-render-diagnostics",
      ],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }
    );
  } catch (error) {
    throw new Error(
      "antidrift-linter must be rebuilt before the Rust rule levels are read, and `cargo build --locked -p antidrift-linter` failed; put the rustup cargo on PATH, or set ANTIDRIFT_LINTER_BIN to a binary built from this checkout",
      { cause: error }
    );
  }
  const executable = output
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => cargoArtifactSchema.parse(JSON.parse(line)))
    .find(
      (message) =>
        message.reason === "compiler-artifact" &&
        message.target?.name === "antidrift-linter" &&
        message.executable
    )?.executable;
  if (!executable) {
    throw new Error(
      "cargo build reported no antidrift-linter executable; the crates/antidrift-linter target must produce a binary"
    );
  }
  return executable;
}

function freshNativeLinterBinary(cwd) {
  if (process.env.ANTIDRIFT_LINTER_BIN) {
    return process.env.ANTIDRIFT_LINTER_BIN;
  }
  if (existsSync(resolve(cwd, "crates/antidrift-linter/Cargo.toml"))) {
    return buildWorkspaceLinter(cwd);
  }
  return resolveNativeArtifact(NATIVE_ARTIFACTS.linter, cwd);
}

export function loadRustRules(cwd = process.cwd()) {
  const binary = freshNativeLinterBinary(cwd);
  if (!binary) {
    throw new Error(
      "antidrift-linter binary not found: install the @joedeleeuw/antidrift-linter platform package or set ANTIDRIFT_LINTER_BIN before generating policy artifacts"
    );
  }
  const output = execFileSync(
    binary,
    ["rust", "--list-rules", "--format", "json", cwd],
    { cwd, encoding: "utf8" }
  );
  return rustRuleSchema.parse(JSON.parse(output));
}

function rustSectionsFor(rustRules) {
  const enabled = rustRules.filter((rule) => rule.level !== "off");
  const general = enabled.filter((rule) => rule.kind === "general");
  const houseStyle = enabled.filter((rule) => rule.kind === "house-style");
  const generalLine =
    general.length === 0
      ? ""
      : `\n- **rust-general** (antidrift-linter rust, levels from \`[workspace.metadata.antidrift]\` in Cargo.toml): ${general
          .map((rule) => rule.id)
          .join(", ")}`;
  const houseStyleLines = houseStyle
    .map((rule) => `- **${rule.id}**: ${rule.guidance}`)
    .join("\n");
  return {
    generalLine,
    houseStyleSection:
      houseStyle.length === 0
        ? ""
        : `\n## Rust house style\n\nOpt-in rules this repository turns on in \`[workspace.metadata.antidrift]\` (Cargo.toml). Follow them before the linter fires.\n\n${houseStyleLines}\n`,
  };
}

function neverLinesFor(meta) {
  return [
    "Do not edit generated policy artifacts directly.",
    "Do not weaken lint/type/test/CI/Sonar/hook configuration unless the task includes `[policy-change]`.",
    "Do not add type escape hatches, silent catches, focused tests, or cross-layer imports.",
    ...(Array.isArray(meta?.never) ? meta.never : []),
  ]
    .map((rule) => `- ${rule}`)
    .join("\n");
}

export function renderPolicyArtifacts(policy, rustRules = []) {
  const clusterLines = clusterLinesFor(policy.clusters);
  const neverLines = neverLinesFor(policy.meta);
  const { generalLine, houseStyleSection } = rustSectionsFor(rustRules);
  const ruleClusters = `${clusterLines}${generalLine}`;
  const artifacts = new Map();
  artifacts.set(
    "AGENTS.md",
    `# Repository Agent Instructions\n\n${POLICY_HEADER}\n\n## Required checks\n\nRun \`pnpm policy:verify-session\` before pushing.\n\n## Never\n\n${neverLines}\n\n## Rule clusters\n\n${ruleClusters}\n${houseStyleSection}`
  );

  artifacts.set(
    "CLAUDE.md",
    `# Claude Project Instructions\n\n${POLICY_HEADER}\n\nTreat hooks and deterministic checks as authoritative. Fix code instead of weakening policy.\n\n## Required checks\n\nRun \`pnpm policy:verify-session\` before pushing.\n\n## Rule clusters\n\n${ruleClusters}\n${houseStyleSection}`
  );

  artifacts.set(
    ".github/copilot-instructions.md",
    `# Copilot Instructions\n\n${POLICY_HEADER}\n\nFollow repository architecture boundaries, avoid type escape hatches, and use public package APIs.\n`
  );

  artifacts.set(
    ".claude/settings.json",
    JSON.stringify({ hooks: AGENT_HOOKS }, null, 2) + "\n"
  );
  artifacts.set(
    ".codex/hooks.json",
    JSON.stringify({ hooks: AGENT_HOOKS }, null, 2) + "\n"
  );
  return artifacts;
}

export async function loadPolicy(policyPath = "policy/agent-guardrails.yaml") {
  const policyText = await readFile(policyPath, "utf8");
  return YAML.parse(policyText);
}

export async function generate() {
  const artifacts = renderPolicyArtifacts(await loadPolicy(), loadRustRules());
  await Promise.all(
    [...artifacts].map(([path, content]) => write(path, content))
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await generate();
}
