import { readFileSync } from "node:fs";
import path from "node:path";

import { protectedPolicyFiles } from "../lib/generated-targets.mjs";

const input = readFileSync(0, "utf8");
const payload = input ? JSON.parse(input) : {};
const explicitPolicyChange =
  JSON.stringify(payload).includes("[policy-change]") ||
  process.env.POLICY_CHANGE === "1";

const toolInput = payload.tool_input ?? {};
const target = toolInput.file_path ?? toolInput.filePath ?? "";

function protectedTarget(filePath) {
  if (!filePath) return null;
  const relative = path
    .relative(process.cwd(), path.resolve(filePath))
    .replace(/\\/gu, "/");
  return protectedPolicyFiles.find((file) => relative === file) ?? null;
}

const blocked = explicitPolicyChange ? null : protectedTarget(target);
if (blocked) {
  console.error(`Blocked edit to protected policy/config file: ${blocked}`);
  console.error(
    "Edit policy/agent-guardrails.yaml and run pnpm policy:generate, or mark an explicit [policy-change] task.",
  );
  process.exit(2);
}
