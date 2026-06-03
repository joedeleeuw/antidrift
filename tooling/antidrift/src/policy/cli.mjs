#!/usr/bin/env node
import { generate } from "./generate-policy-artifacts.mjs";
import { checkGenerated } from "./check-generated-policy-artifacts.mjs";
import { checkChanged } from "./check-changed.mjs";
import { checkRegistries } from "./check-registries.mjs";
import { checkRuleSurface } from "./check-rule-surface.mjs";
import { parseArgs as parseRepoCorpusArgs, repoCorpus } from "./repo-corpus.mjs";
import { parseArgs as parseChaskiCorpusArgs, chaskiCorpus } from "./chaski-corpus.mjs";
import { parseArgs as parseExternalCorpusArgs, externalCorpus } from "./external-corpus.mjs";
import { verifySession } from "./verify-session.mjs";
import { eslintJsonToSonar } from "./eslint-json-to-sonar.mjs";

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
  "check-rule-surface": () => {
    if (!checkRuleSurface()) process.exitCode = 1;
  },
  "repo-corpus": async () => {
    const result = await repoCorpus(parseRepoCorpusArgs(args));
    if (result.decision !== "pass") process.exitCode = 1;
  },
  "chaski-corpus": async () => {
    const result = await chaskiCorpus(parseChaskiCorpusArgs(args));
    if (result.decision === "fail") process.exitCode = 1;
  },
  "external-corpus": async () => {
    const result = await externalCorpus(parseExternalCorpusArgs(args));
    if (result.decision === "fail") process.exitCode = 1;
  },
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
