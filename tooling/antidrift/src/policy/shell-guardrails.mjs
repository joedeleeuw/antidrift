import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function defaultAstGrepConfig() {
  return join(packageRoot, "ast-grep", "sgconfig.yml");
}

export function defaultAstGrepBinary(env = process.env) {
  return (
    env.AST_GREP_BIN ??
    env.AST_GREP_BINARY ??
    (process.platform === "win32" ? "ast-grep.exe" : "ast-grep")
  );
}

export function parseShellGuardrailsArgs(argv = [], env = process.env) {
  const parsed = {
    astGrepBinary: defaultAstGrepBinary(env),
    config: defaultAstGrepConfig(),
    cwd: process.cwd(),
    mode: "scan",
    passthrough: [],
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "test" || arg === "--test") {
      parsed.mode = "test";
    } else if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--config" && next) {
      parsed.config = next;
      index += 1;
    } else if (arg === "--cwd" && next) {
      parsed.cwd = next;
      index += 1;
    } else if (arg === "--ast-grep-bin" && next) {
      parsed.astGrepBinary = next;
      index += 1;
    } else if (arg === "--") {
      parsed.passthrough.push(...argv.slice(index + 1));
      break;
    } else {
      parsed.passthrough.push(arg);
    }
  }

  return parsed;
}

function isPathLikeCommand(command) {
  return command.includes("/") || command.includes("\\");
}

export function shellGuardrails({
  argv = [],
  exists = existsSync,
  spawn = spawnSync,
  stderr = process.stderr,
  env = process.env,
} = {}) {
  const parsed = parseShellGuardrailsArgs(argv, env);
  if (parsed.help) {
    stderr.write(
      [
        "Usage: antidrift shell [test|--test] [--config <sgconfig.yml>] [--cwd <dir>] [-- <ast-grep args>]",
        "",
        "Runs Antidrift's packaged ast-grep shell guardrails against the current project.",
        "Default mode scans the current project. Test mode validates the packaged rule tests.",
        "",
      ].join("\n"),
    );
    return 0;
  }

  if (isPathLikeCommand(parsed.astGrepBinary) && !exists(parsed.astGrepBinary)) {
    stderr.write(
      `antidrift shell: ast-grep binary not found: ${parsed.astGrepBinary}\n`,
    );
    return 1;
  }

  const commandArgs =
    parsed.mode === "test"
      ? [
          "test",
          "--config",
          parsed.config,
          "--skip-snapshot-tests",
          ...parsed.passthrough,
        ]
      : [
          "scan",
          "--config",
          parsed.config,
          ...(parsed.passthrough.length > 0 ? parsed.passthrough : ["."]),
        ];

  const result = spawn(parsed.astGrepBinary, commandArgs, {
    cwd: parsed.cwd,
    env,
    stdio: "inherit",
  });

  if (result.error) {
    stderr.write(`antidrift shell: ${result.error.message}\n`);
    return 1;
  }

  return result.status ?? 1;
}
