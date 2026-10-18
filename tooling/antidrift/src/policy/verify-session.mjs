import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const STEP_TIMEOUT_MS = 360_000;

export function verifySession() {
  const releaseGate = spawnSync("pnpm", ["verify:release"], {
    stdio: "inherit",
    timeout: STEP_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  if (releaseGate.error?.code === "ETIMEDOUT") {
    console.error(
      `Required verification timed out after ${STEP_TIMEOUT_MS / 60_000}m: pnpm verify:release`
    );
    process.exit(1);
  }
  if (releaseGate.error) throw releaseGate.error;
  if (releaseGate.status !== 0) {
    console.error("Required verification failed: pnpm verify:release");
    process.exit(releaseGate.status ?? 1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  verifySession();
}
