#!/usr/bin/env node
import { generate } from "./generate-policy-artifacts.mjs";
import { checkGenerated } from "./check-generated-policy-artifacts.mjs";
import { checkChanged } from "./check-changed.mjs";
import { verifySession } from "./verify-session.mjs";
import { eslintJsonToSonar } from "./eslint-json-to-sonar.mjs";

const [, , command, ...args] = process.argv;

const commands = {
  generate,
  "check-generated": checkGenerated,
  "check-changed": checkChanged,
  "verify-session": verifySession,
  sonar: () => eslintJsonToSonar(args[0], args[1]),
};

const run = commands[command];
if (!run) {
  console.error(`Unknown command: ${command ?? "(none)"}`);
  console.error(`Usage: antidrift <${Object.keys(commands).join("|")}>`);
  process.exit(1);
}

await run();
