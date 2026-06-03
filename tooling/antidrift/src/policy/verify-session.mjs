import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function verifySession() {
  /** @type {[string, string[]][]} */
  const commands = [
    ["pnpm", ["policy:check-generated"]],
    ["pnpm", ["policy:check-registries"]],
    ["pnpm", ["policy:check-rule-surface"]],
    ["pnpm", ["policy:validate-corpus"]],
    ["pnpm", ["policy:validate-external-corpus"]],
    ["pnpm", ["lint"]],
    ["pnpm", ["typecheck"]],
    ["pnpm", ["test"]],
  ];

  for (const [command, args] of commands) {
    const result = spawnSync(command, args, { stdio: "inherit" });
    if (result.status !== 0) {
      console.error(`Required verification failed: ${command} ${args.join(" ")}`);
      process.exit(result.status ?? 1);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  verifySession();
}
