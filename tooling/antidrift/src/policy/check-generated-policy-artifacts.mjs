import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { generate } from "./generate-policy-artifacts.mjs";
import { generatedTargets } from "./lib/generated-targets.mjs";

async function readOrNull(target) {
  try {
    return await readFile(target, "utf8");
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
    return null;
  }
}

async function snapshot() {
  const entries = await Promise.all(generatedTargets.map(async (target) => [target, await readOrNull(target)]));
  return new Map(entries);
}

export async function checkGenerated() {
  const before = await snapshot();
  await generate();
  const after = await snapshot();

  let failed = false;
  for (const target of generatedTargets) {
    if (before.get(target) !== after.get(target)) {
      console.error(`Generated policy artifact was stale: ${target}`);
      failed = true;
    }
  }

  if (failed) {
    console.error("Run `pnpm policy:generate` and commit the generated files.");
    process.exitCode = 1;
  }
  return !failed;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await checkGenerated();
}
