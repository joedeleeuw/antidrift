import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pnpmEntry = process.env.npm_execpath;
if (!pnpmEntry) {
  throw new Error(
    "consumer-monorepo.mjs runs through pnpm (pnpm package:verify): npm_execpath is unset"
  );
}
export const pnpmLaunch = /\.[cm]?js$/u.test(pnpmEntry)
  ? { file: process.execPath, prefix: [pnpmEntry] }
  : { file: pnpmEntry, prefix: [] };

export const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const work = realpathSync.native(
  mkdtempSync(join(tmpdir(), "antidrift-consumer-"))
);

export function run(cmd, args, cwd) {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 300_000,
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024 * 1024,
  });
}

export function runInherit(cmd, args, cwd) {
  return execFileSync(cmd, args, {
    cwd,
    stdio: "inherit",
    timeout: 300_000,
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024 * 1024,
  });
}

export function runJson(cmd, args, cwd) {
  return JSON.parse(run(cmd, args, cwd));
}

export function file(rel, fileContents) {
  const targetPath = join(work, rel);
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, fileContents, "utf8");
}

export function runGeneratedHook(command, payload) {
  const completed = spawnSync(command, {
    cwd: work,
    shell: true,
    encoding: "utf8",
    input: JSON.stringify(payload),
    timeout: 120_000,
  });
  if (completed.error) throw completed.error;
  return completed;
}

export function fail(message) {
  console.error(`\n✗ ${message}`);
  console.error(`  (left workspace for inspection: ${work})`);
  process.exit(1);
}
