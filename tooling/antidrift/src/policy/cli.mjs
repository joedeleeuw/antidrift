#!/usr/bin/env node
import { checkChanged } from "./check-changed.mjs";
import { checkGenerated } from "./check-generated-policy-artifacts.mjs";
import { checkRegistries } from "./check-registries.mjs";
import { generate } from "./generate-policy-artifacts.mjs";
import { blockGeneratedPolicyEdits } from "./hooks/block-generated-policy-edits.mjs";
import { runOxlint } from "./oxlint.mjs";
import { shellGuardrails } from "./shell-guardrails.mjs";
import { verifySession } from "./verify-session.mjs";

const [, , command, ...args] = process.argv;

const AGENT_HOOKS = {
  "block-generated-policy-edits": blockGeneratedPolicyEdits,
};

function runAgentHook(name) {
  const hook = AGENT_HOOKS[name];
  if (!hook) {
    console.error(
      `Unknown agent hook: ${name ?? "(none)"}. Usage: antidrift hook <${Object.keys(AGENT_HOOKS).join("|")}>`
    );
    return 1;
  }
  return hook();
}

const commands = {
  generate,
  "check-generated": async () => {
    if (!(await checkGenerated())) process.exitCode = 1;
  },
  "check-changed": checkChanged,
  "check-registries": () => {
    if (!checkRegistries()) process.exitCode = 1;
  },
  shell: () => {
    process.exitCode = shellGuardrails({ argv: args });
  },
  "verify-session": verifySession,
  hook: () => {
    process.exitCode = runAgentHook(args[0]);
  },
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
