import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPolicy, renderPolicyArtifacts } from "./generate-policy-artifacts.mjs";

async function readOrNull(target) {
  try {
    return await readFile(target, "utf8");
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
    return null;
  }
}

export async function checkGenerated({ repoRoot = process.cwd(), policyPath = join(repoRoot, "policy/agent-guardrails.yaml"), report = console.error } = {}) {
  const artifacts = renderPolicyArtifacts(await loadPolicy(policyPath));
  const comparisons = await Promise.all([...artifacts].map(async ([target, expected]) => ({
    target,
    stale: await readOrNull(join(repoRoot, target)) !== expected,
  })));

  const staleTargets = comparisons.filter(({ stale }) => stale).map(({ target }) => target);
  for (const target of staleTargets) report(`Generated policy artifact was stale: ${target}`);
  const failed = staleTargets.length > 0;
  if (failed) {
    report("Run `pnpm policy:generate` and commit the generated files.");
  }
  return !failed;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!(await checkGenerated())) process.exitCode = 1;
}
