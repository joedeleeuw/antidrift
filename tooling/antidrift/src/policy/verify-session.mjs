import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const defaultCommands = [
  ["pnpm", ["policy:check-generated"]],
  ["pnpm", ["policy:check-registries"]],
  ["pnpm", ["policy:check-rule-surface"]],
  ["pnpm", ["policy:inventory-change-contract"]],
  ["pnpm", ["policy:inventory-diff-scoped-adapters"]],
  ["pnpm", ["policy:validate-corpus"]],
  ["pnpm", ["policy:validate-external-corpus"]],
  ["pnpm", ["package:verify"]],
  ["pnpm", ["lint"]],
  ["pnpm", ["typecheck"]],
  ["pnpm", ["test"]],
];

const STEP_TIMEOUT_MS = 360_000;
const MAX_HOOK_OUTPUT_BUFFER = 32 * 1024 * 1024;
const defaultStdout = { write: (value) => process.stdout.write(value) };
const defaultStderr = { write: (value) => process.stderr.write(value) };
const defaultExit = (status) => process.exit(status);

function commandText(command, args) {
  return [command, ...args].join(" ");
}

function capturedOutput(result) {
  return [result.stdout, result.stderr, result.error?.message]
    .filter((value) => typeof value === "string" && value.trim())
    .join("\n")
    .trim();
}

function tailLines(text, maxLines = 18) {
  return text
    .split(/\r?\n/u)
    .filter((line) => line.trim())
    .slice(-maxLines)
    .join("\n");
}

function verificationReason(message, result) {
  const output = tailLines(capturedOutput(result));
  return output ? `${message}\n\n${output}` : message;
}

function emitFailure({ hook, reason, status, stdout, stderr, exit }) {
  if (hook) {
    stdout.write(`${JSON.stringify({ decision: "block", reason })}\n`);
    return exit(0);
  }
  stderr.write(`${reason}\n`);
  return exit(status);
}

export function verifySession({
  commands = defaultCommands,
  hook = false,
  spawn = spawnSync,
  stdout = defaultStdout,
  stderr = defaultStderr,
  exit = defaultExit,
} = {}) {
  for (const [command, args] of commands) {
    const result = spawn(command, args, {
      stdio: hook ? "pipe" : "inherit",
      encoding: "utf8",
      timeout: STEP_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: MAX_HOOK_OUTPUT_BUFFER,
    });
    const text = commandText(command, args);
    if (result.error?.code === "ETIMEDOUT") {
      return emitFailure({
        hook,
        reason: verificationReason(
          `Required verification timed out after ${STEP_TIMEOUT_MS / 60_000}m: ${text}`,
          result,
        ),
        status: 1,
        stdout,
        stderr,
        exit,
      });
    }
    if (result.status !== 0) {
      return emitFailure({
        hook,
        reason: verificationReason(`Required verification failed: ${text}`, result),
        status: result.status ?? 1,
        stdout,
        stderr,
        exit,
      });
    }
  }
  return undefined;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  verifySession();
}
