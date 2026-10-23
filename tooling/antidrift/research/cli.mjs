#!/usr/bin/env node
// Maintainer research commands: corpus runs, inventories and benchmarks over local checkouts.
// They are not part of the published package.
import {
  declarationCloneInventory,
  parseArgs as parseDeclarationCloneInventoryArgs,
} from "./policy/declaration-clone-inventory.mjs";
import {
  defensiveShapeInventory,
  parseArgs as parseDefensiveShapeInventoryArgs,
} from "./policy/defensive-shape-inventory.mjs";
import {
  externalCorpus,
  parseArgs as parseExternalCorpusArgs,
} from "./policy/external-corpus/runner.mjs";
import {
  parseArgs as parseReactStateInventoryArgs,
  reactStateInventory,
} from "./policy/react-state-inventory.mjs";
import {
  parseArgs as parseRepoCorpusArgs,
  repoCorpus,
} from "./policy/repo-corpus.mjs";
import {
  parseArgs as parseSqlBroadInventoryArgs,
  sqlBroadInventory,
} from "./policy/sql-broad-inventory.mjs";
import {
  parseArgs as parseSqlQueryBenchmarkArgs,
  sqlQueryBenchmark,
} from "./policy/sql-query-benchmark.mjs";
import {
  parseTypeOwnerInventoryArgs,
  typeOwnerInventory,
} from "./policy/type-owner-inventory.mjs";
import {
  parseArgs as parseUndercheckedPredicateInventoryArgs,
  undercheckedPredicateInventory,
} from "./policy/underchecked-predicate-inventory.mjs";
import { changeContractEvidenceCommand } from "./change-scope/change-contract-evidence.mjs";
import { changeContractCommand } from "./change-scope/change-contract.mjs";
import { diffScopedAdaptersCommand } from "./change-scope/diff-scoped-adapters.mjs";

const [, , command, ...args] = process.argv;

const commands = {
  "repo-corpus": async () => {
    const corpusRun = await repoCorpus(parseRepoCorpusArgs(args));
    if (corpusRun.decision !== "pass") process.exitCode = 1;
  },
  "external-corpus": async () => {
    const parsed = parseExternalCorpusArgs(args);
    const corpusRun = await externalCorpus({
      ...parsed,
      output: parsed.output ?? "reports/external-corpus.json",
      report: console.error,
    });
    if (corpusRun.decision === "fail") process.exitCode = 1;
  },
  "benchmark-sql-queries": () =>
    sqlQueryBenchmark(parseSqlQueryBenchmarkArgs(args)),
  "inventory-sql-broad": () =>
    sqlBroadInventory(parseSqlBroadInventoryArgs(args)),
  "inventory-defensive-shape": () =>
    defensiveShapeInventory(parseDefensiveShapeInventoryArgs(args)),
  "inventory-declaration-clone": () =>
    declarationCloneInventory(parseDeclarationCloneInventoryArgs(args)),
  "inventory-react-state": () =>
    reactStateInventory(parseReactStateInventoryArgs(args)),
  "inventory-underchecked-predicate": () =>
    undercheckedPredicateInventory(
      parseUndercheckedPredicateInventoryArgs(args)
    ),
  "inventory-type-owner": () =>
    typeOwnerInventory(parseTypeOwnerInventoryArgs(args)),
  "change-contract-evidence": () => changeContractEvidenceCommand(args),
  "change-contract": () => changeContractCommand(args),
  "diff-scoped-adapters": () => diffScopedAdaptersCommand(args),
};

const run = commands[command];
if (!run) {
  console.error(`Unknown command: ${command ?? "(none)"}`);
  console.error(`Usage: research <${Object.keys(commands).join("|")}>`);
  process.exit(1);
}

await run();
