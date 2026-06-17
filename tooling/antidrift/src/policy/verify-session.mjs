import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function verifySession() {
  /** @type {[string, string[]][]} */
  const commands = [
    ["pnpm", ["policy:check-generated"]],
    ["pnpm", ["policy:check-registries"]],
    ["pnpm", ["policy:check-rule-surface"]],
    ["pnpm", ["policy:inventory-change-contract"]],
    ["pnpm", ["policy:validate-corpus"]],
    ["pnpm", ["policy:validate-external-corpus"]],
    ["pnpm", ["package:verify"]],
    ["pnpm", ["lint"]],
    ["pnpm", ["typecheck"]],
    ["pnpm", ["test"]],
  ];

  const STEP_TIMEOUT_MS = 360_000;
  for (const [command, args] of commands) {
    const result = spawnSync(command, args, { stdio: "inherit", timeout: STEP_TIMEOUT_MS, killSignal: "SIGKILL" });
    if (result.error?.code === "ETIMEDOUT") {
      console.error(`Required verification timed out after ${STEP_TIMEOUT_MS / 60_000}m: ${command} ${args.join(" ")}`);
      process.exit(1);
    }
    if (result.status !== 0) {
      console.error(`Required verification failed: ${command} ${args.join(" ")}`);
      process.exit(result.status ?? 1);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  verifySession();
}
