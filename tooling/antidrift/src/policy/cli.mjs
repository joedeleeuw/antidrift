#!/usr/bin/env node
import {
  chaskiCorpus,
  parseArgs as parseChaskiCorpusArgs,
} from "./chaski-corpus.mjs";
import { checkChanged } from "./check-changed.mjs";
import { checkGenerated } from "./check-generated-policy-artifacts.mjs";
import { checkRegistries } from "./check-registries.mjs";
import { checkRuleSurface } from "./check-rule-surface.mjs";
import { eslintJsonToSonar } from "./eslint-json-to-sonar.mjs";
import {
  externalCorpus,
  parseArgs as parseExternalCorpusArgs,
} from "./external-corpus.mjs";
import { generate } from "./generate-policy-artifacts.mjs";
import {
  noAppeasementRemediationCorpus,
  parseArgs as parseNoAppeasementRemediationArgs,
} from "./no-appeasement-remediation-corpus.mjs";
import {
  parseArgs as parseRepoCorpusArgs,
  repoCorpus,
} from "./repo-corpus.mjs";
import {
  parseArgs as parseSchemaRoundtripInventoryArgs,
  schemaRoundtripInventory,
} from "./schema-roundtrip-inventory.mjs";
import {
  parseArgs as parseSqlBroadInventoryArgs,
  sqlBroadInventory,
} from "./sql-broad-inventory.mjs";
import {
  parseArgs as parseSqlQueryBenchmarkArgs,
  sqlQueryBenchmark,
} from "./sql-query-benchmark.mjs";
import {
  parseArgs as parseUnsafeTypeAssertionBenchmarkArgs,
  unsafeTypeAssertionBenchmark,
} from "./unsafe-type-assertion-benchmark.mjs";
import { verifySession } from "./verify-session.mjs";

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
  "no-appeasement-remediation-corpus": async () => {
    const result = await noAppeasementRemediationCorpus(
      parseNoAppeasementRemediationArgs(args),
    );
    if (result.decision === "fail") process.exitCode = 1;
  },
  "benchmark-unsafe-type-assertion": () =>
    unsafeTypeAssertionBenchmark(parseUnsafeTypeAssertionBenchmarkArgs(args)),
  "benchmark-sql-queries": () =>
    sqlQueryBenchmark(parseSqlQueryBenchmarkArgs(args)),
  "inventory-sql-broad": () =>
    sqlBroadInventory(parseSqlBroadInventoryArgs(args)),
  "inventory-schema-roundtrip": () =>
    schemaRoundtripInventory(parseSchemaRoundtripInventoryArgs(args)),
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
