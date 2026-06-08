import { readFileSync } from "node:fs";

import { protectedPolicyFiles } from "../lib/generated-targets.mjs";

const input = readFileSync(0, "utf8");
const payload = input ? JSON.parse(input) : {};
const raw = JSON.stringify(payload);
const explicitPolicyChange = raw.includes("[policy-change]") || process.env.POLICY_CHANGE === "1";

for (const file of protectedPolicyFiles) {
  if (raw.includes(file) && !explicitPolicyChange) {
    console.error(`Blocked edit to protected policy/config file: ${file}`);
    console.error("Edit policy/agent-guardrails.yaml and run pnpm policy:generate, or mark an explicit [policy-change] task.");
    process.exit(2);
  }
}
