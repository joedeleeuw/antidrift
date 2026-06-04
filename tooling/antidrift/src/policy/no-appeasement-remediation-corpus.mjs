import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCorpusCases } from "./chaski-corpus.mjs";

const chaskiRemediationRepoCandidates = [
  process.env.CHASKI_REMEDIATION_REPO,
  "/Users/sushi/code/[antidrift-no-appeasement-remediation]-chaski",
].filter(Boolean);
const codebaseAtlasRemediationRepoCandidates = [
  process.env.CODEBASE_ATLAS_REMEDIATION_REPO,
  "/Users/sushi/code/[antidrift-no-appeasement-remediation]-codebase-atlas",
].filter(Boolean);

const chaskiRemediationCases = [
  {
    id: "portal-api-service-axios-error-guard-clean",
    ruleId: "antidrift/no-appeasement-cast",
    kind: "correct",
    classification: "ready",
    subproject: "frontend",
    typeAware: true,
    tsconfig: "src/frontend/portal/tsconfig.json",
    paths: ["src/frontend/portal/api/apiService.ts"],
  },
  {
    id: "portal-impersonation-session-json-guard-clean",
    ruleId: "antidrift/no-appeasement-cast",
    kind: "correct",
    classification: "ready",
    subproject: "frontend",
    typeAware: true,
    tsconfig: "src/frontend/portal/tsconfig.json",
    paths: ["src/frontend/portal/components/ImpersonationWarning.tsx"],
  },
];

const codebaseAtlasRemediationCases = [
  {
    id: "atlas-needle-renderer-userdata-color-guard-clean",
    ruleId: "antidrift/no-appeasement-cast",
    kind: "correct",
    classification: "ready",
    subproject: "app",
    typeAware: true,
    tsconfig: "tsconfig.json",
    paths: ["src/needle/AtlasNeedleRenderer.ts"],
  },
  {
    id: "atlas-terrain-layout-anchor-schema-guard-clean",
    ruleId: "antidrift/no-appeasement-cast",
    kind: "correct",
    classification: "ready",
    subproject: "app",
    typeAware: true,
    tsconfig: "tsconfig.json",
    paths: ["src/programs/persistenceCuration.ts"],
  },
];

function parseArgs(argv) {
  const out = { slice: "no-appeasement-remediation-copy", output: null, require: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--slice" && next) {
      out.slice = next;
      i += 1;
    } else if (arg === "--output" && next) {
      out.output = next;
      i += 1;
    } else if (arg === "--require") {
      out.require = true;
    }
  }
  return out;
}

function decisionFor(repositories, require) {
  if (repositories.some((result) => result.decision === "fail")) return "fail";
  if (repositories.some((result) => result.decision === "pass")) return "pass";
  return require ? "fail" : "skip";
}

function emitSummary(summary, output, report) {
  const json = `${JSON.stringify(summary, null, 2)}\n`;
  if (output) {
    writeFileSync(resolve(output), json, "utf8");
  } else {
    report(json.trimEnd());
  }
}

export async function noAppeasementRemediationCorpus({
  slice = "no-appeasement-remediation-copy",
  output = null,
  require = false,
  report = console.log,
} = {}) {
  const repositories = await Promise.all([
    runCorpusCases({
      corpus: "chaski-remediation",
      corpusLabel: "Chaski remediation copy",
      repoCandidates: chaskiRemediationRepoCandidates,
      slice,
      require,
      cases: chaskiRemediationCases,
      report: () => {},
    }),
    runCorpusCases({
      corpus: "codebase-atlas-remediation",
      corpusLabel: "Codebase Atlas remediation copy",
      repoCandidates: codebaseAtlasRemediationRepoCandidates,
      slice,
      require,
      cases: codebaseAtlasRemediationCases,
      report: () => {},
    }),
  ]);
  const summary = {
    schemaVersion: 1,
    corpus: "no-appeasement-remediation",
    slice,
    decision: decisionFor(repositories, require),
    repositories,
  };
  emitSummary(summary, output, report);
  return summary;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await noAppeasementRemediationCorpus(parseArgs(process.argv.slice(2)));
  if (result.decision === "fail") process.exitCode = 1;
}

export { parseArgs };
