#!/usr/bin/env node
import { checkChanged } from "./check-changed.mjs";
import { checkGenerated } from "./check-generated-policy-artifacts.mjs";
import { checkRegistries } from "./check-registries.mjs";
import { checkRuleSurface } from "./check-rule-surface.mjs";
import { generate } from "./generate-policy-artifacts.mjs";
import {
  loadRuleStatusRegistrySync,
  ruleStatusEntriesForKind,
  ruleStatusEntriesForProofBucket,
  ruleStatusEntriesForSemanticAdapter,
  ruleStatusEntriesForStatus,
  ruleStatusManifest,
  ruleStatusSemanticSummaries,
} from "./lib/rule-status.mjs";
import { shellGuardrails } from "./shell-guardrails.mjs";
import { verifySession } from "./verify-session.mjs";
import {
  SEMANTIC_ADAPTER_MANIFEST,
  semanticAdapterManifestForAdapterId,
  semanticAdapterManifestForFactAdapterId,
  semanticAdapterManifestForFactKind,
  semanticAdapterManifestForProofBucket,
  semanticAdapterManifestForRule,
} from "../semantic-adapters/index.mjs";

const [, , command, ...args] = process.argv;

function parseRuleStatusArgs(argv) {
  const parsed = {
    policyDir: "policy",
    filters: [],
    semanticSummary: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--kind" && next) {
      parsed.filters.push((manifest) => ({
        ...manifest,
        entries: ruleStatusEntriesForKind(next, manifest),
      }));
      index += 1;
    } else if (arg === "--status" && next) {
      parsed.filters.push((manifest) => ({
        ...manifest,
        entries: ruleStatusEntriesForStatus(next, manifest),
      }));
      index += 1;
    } else if ((arg === "--semantic-adapter" || arg === "--adapter") && next) {
      parsed.filters.push((manifest) => ({
        ...manifest,
        entries: ruleStatusEntriesForSemanticAdapter(next, manifest),
      }));
      index += 1;
    } else if (arg === "--proof-bucket" && next) {
      parsed.filters.push((manifest) => ({
        ...manifest,
        entries: ruleStatusEntriesForProofBucket(next, manifest),
      }));
      index += 1;
    } else if (arg === "--semantic-summary") {
      parsed.semanticSummary = true;
    } else if (!arg.startsWith("--")) {
      parsed.policyDir = arg;
    }
  }
  return parsed;
}

function ruleStatusCommand(argv) {
  const parsed = parseRuleStatusArgs(argv);
  const manifest = ruleStatusManifest(
    loadRuleStatusRegistrySync(parsed.policyDir)
  );
  const filteredManifest = parsed.filters.reduce(
    (current, filter) => Object.freeze(filter(current)),
    manifest
  );
  if (!parsed.semanticSummary) return filteredManifest;
  return Object.freeze({
    schemaVersion: filteredManifest.schemaVersion,
    promotionRequirements: filteredManifest.promotionRequirements,
    summaries: ruleStatusSemanticSummaries(filteredManifest),
  });
}

function parseSemanticManifestArgs(argv) {
  const parsed = { filters: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if ((arg === "--adapter" || arg === "--semantic-adapter") && next) {
      parsed.filters.push(() => {
        const entry = semanticAdapterManifestForAdapterId(next);
        return entry ? [entry] : [];
      });
      index += 1;
    } else if (arg === "--rule" && next) {
      parsed.filters.push(() => semanticAdapterManifestForRule(next));
      index += 1;
    } else if (arg === "--proof-bucket" && next) {
      parsed.filters.push(() => semanticAdapterManifestForProofBucket(next));
      index += 1;
    } else if (
      (arg === "--fact-adapter" || arg === "--semantic-fact-adapter") &&
      next
    ) {
      parsed.filters.push(() => semanticAdapterManifestForFactAdapterId(next));
      index += 1;
    } else if (arg === "--fact-kind" && next) {
      parsed.filters.push(() => semanticAdapterManifestForFactKind(next));
      index += 1;
    }
  }
  return parsed;
}

function semanticManifestCommand(argv) {
  const parsed = parseSemanticManifestArgs(argv);
  return parsed.filters.reduce((entries, filter) => {
    const nextEntries = filter();
    const allowed = new Set(entries.map((entry) => entry.id));
    return nextEntries.filter((entry) => allowed.has(entry.id));
  }, SEMANTIC_ADAPTER_MANIFEST);
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
  "check-rule-surface": () => {
    if (!checkRuleSurface()) process.exitCode = 1;
  },
  shell: () => {
    process.exitCode = shellGuardrails({ argv: args });
  },
  "verify-session": verifySession,
  "semantic-manifest": () => {
    process.stdout.write(
      `${JSON.stringify(semanticManifestCommand(args), null, 2)}\n`
    );
  },
  "rule-status": () => {
    process.stdout.write(
      `${JSON.stringify(ruleStatusCommand(args), null, 2)}\n`
    );
  },
};

const run = commands[command];
if (!run) {
  console.error(`Unknown command: ${command ?? "(none)"}`);
  console.error(`Usage: antidrift <${Object.keys(commands).join("|")}>`);
  process.exit(1);
}

await run();
