import { fileURLToPath } from "node:url";

import { externalCorpus, parseArgs } from "./external-corpus/runner.mjs";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const parsed = parseArgs(process.argv.slice(2));
  const result = await externalCorpus({
    ...parsed,
    output: parsed.output ?? "reports/external-corpus.json",
    report: console.error,
  });
  if (result.decision === "fail") process.exitCode = 1;
}
