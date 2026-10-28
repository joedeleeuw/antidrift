#!/usr/bin/env node
import { checkChanged } from "./check-changed.mjs";
import { checkGenerated } from "./check-generated-policy-artifacts.mjs";
import { checkRegistries } from "./check-registries.mjs";
import { generate } from "./generate-policy-artifacts.mjs";
import { runOxlint } from "./oxlint.mjs";
import { shellGuardrails } from "./shell-guardrails.mjs";
import { verifySession } from "./verify-session.mjs";
import { changeContractEvidenceCommand } from "../change-scope/change-contract-evidence.mjs";
import { changeContractCommand } from "../change-scope/change-contract.mjs";
import { diffScopedAdaptersCommand } from "../change-scope/diff-scoped-adapters.mjs";

const [, , command, ...args] = process.argv;

const commands = {
  generate,
  "check-generated": async () => {
    if (!(await checkGenerated())) process.exitCode = 1;
  },
  "check-changed": checkChanged,
  "check-registries": () => {
    if (!checkRegistries()) process.exitCode = 1;
  },
  "change-contract-evidence": () => changeContractEvidenceCommand(args),
  "change-contract": () => changeContractCommand(args),
  "diff-scoped-adapters": () => diffScopedAdaptersCommand(args),
  shell: () => {
    process.exitCode = shellGuardrails({ argv: args });
  },
  "verify-session": verifySession,
  oxlint: () => {
    process.exitCode = runOxlint({
      argv: args,
      exit: (code) => code,
    });
  },
};

const run = commands[command];
if (!run) {
  console.error(`Unknown command: ${command ?? "(none)"}`);
  console.error(`Usage: antidrift <${Object.keys(commands).join("|")}>`);
  process.exit(1);
}

await run();
