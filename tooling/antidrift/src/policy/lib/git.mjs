import { spawnSync } from "node:child_process";

/** @param {string[]} args */
export function git(args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) return "";
  return result.stdout.trim();
}

export function changedFiles() {
  const outputs = [
    git(["diff", "--name-only", "--diff-filter=ACMRTUXB", "HEAD"]),
    git(["diff", "--name-only", "--diff-filter=ACMRTUXB", "--cached"]),
  ];
  return [...new Set(outputs.flatMap((output) => output.split("\n")).filter(Boolean))];
}
