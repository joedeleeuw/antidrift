import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCorpusCases } from "./chaski-corpus.mjs";

const sudocodeRepoCandidates = [process.env.SUDOCODE_REPO, "/Users/sushi/code/sudocode-main"].filter(Boolean);
const codebaseAtlasRepoCandidates = [process.env.CODEBASE_ATLAS_REPO, "/Users/sushi/code/codebase-atlas"].filter(Boolean);
const coreRuleIds = new Set(["no-restricted-imports"]);

const sudocodeCases = [
  {
    id: "sudocode-multi-project-async-foreach-cleanup",
    ruleId: "antidrift/no-async-array-method",
    kind: "drift",
    classification: "ready",
    subproject: "server",
    paths: ["server/tests/integration/multi-project.test.ts"],
    expectedFindings: [
      {
        path: "server/tests/integration/multi-project.test.ts",
        line: 142,
      },
    ],
  },
  {
    id: "sudocode-projects-route-promise-all-map-clean",
    ruleId: "antidrift/no-async-array-method",
    kind: "correct",
    classification: "ready",
    subproject: "server",
    paths: ["server/src/routes/projects.ts"],
  },
  {
    id: "sudocode-workflows-route-json-parse-any-row",
    ruleId: "antidrift/no-unsafe-deserialize",
    kind: "drift",
    classification: "ready",
    subproject: "server",
    typeAware: true,
    tsconfig: "server/tsconfig.json",
    paths: ["server/src/routes/workflows.ts"],
    expectedFindings: [
      {
        path: "server/src/routes/workflows.ts",
        line: 199,
      },
    ],
  },
  {
    id: "sudocode-base-workflow-typed-row-json-parse-clean",
    ruleId: "antidrift/no-unsafe-deserialize",
    kind: "correct",
    classification: "ready",
    subproject: "server",
    typeAware: true,
    tsconfig: "server/tsconfig.json",
    paths: ["server/src/workflow/base-workflow-engine.ts"],
  },
  {
    id: "sudocode-config-read-file-json-parse-string-clean",
    ruleId: "antidrift/no-unsafe-deserialize",
    kind: "correct",
    classification: "ready",
    subproject: "server",
    typeAware: true,
    tsconfig: "server/tsconfig.json",
    paths: ["server/src/routes/config.ts"],
  },
  {
    id: "sudocode-issues-route-params-without-authz",
    ruleId: "antidrift/require-authz-check",
    kind: "drift",
    classification: "ready",
    subproject: "server",
    paths: ["server/src/routes/issues.ts"],
    expectedFindings: [
      {
        path: "server/src/routes/issues.ts",
        line: 78,
      },
    ],
  },
  {
    id: "sudocode-version-route-no-params-clean",
    ruleId: "antidrift/require-authz-check",
    kind: "correct",
    classification: "ready",
    subproject: "server",
    paths: ["server/src/routes/version.ts"],
  },
  {
    id: "sudocode-chat-widget-hover-translate-fab",
    ruleId: "antidrift/no-hover-translate-card",
    kind: "drift",
    classification: "ready",
    subproject: "frontend",
    paths: ["frontend/src/components/chat-widget/ChatWidgetFAB.tsx"],
    expectedFindings: [
      {
        path: "frontend/src/components/chat-widget/ChatWidgetFAB.tsx",
        line: 23,
      },
    ],
  },
  {
    id: "sudocode-ui-button-no-hover-translate-clean",
    ruleId: "antidrift/no-hover-translate-card",
    kind: "correct",
    classification: "ready",
    subproject: "frontend",
    paths: ["frontend/src/components/ui/button.tsx"],
  },
];

const codebaseAtlasCases = [
  {
    id: "atlas-needle-renderer-userdata-color-appeasement-cast",
    ruleId: "antidrift/no-appeasement-cast",
    kind: "drift",
    classification: "ready",
    subproject: "app",
    typeAware: true,
    tsconfig: "tsconfig.json",
    paths: ["src/needle/AtlasNeedleRenderer.ts"],
    expectedFindings: [
      {
        path: "src/needle/AtlasNeedleRenderer.ts",
        line: 200,
      },
    ],
  },
  {
    id: "atlas-terrain-layout-anchor-appeasement-cast",
    ruleId: "antidrift/no-appeasement-cast",
    kind: "drift",
    classification: "ready",
    subproject: "app",
    typeAware: true,
    tsconfig: "tsconfig.json",
    paths: ["src/programs/persistenceCuration.ts"],
    expectedFindings: [
      {
        path: "src/programs/persistenceCuration.ts",
        line: 646,
      },
    ],
  },
  {
    id: "atlas-terrain-layout-anchor-field-checked-predicate-clean",
    ruleId: "antidrift/no-underchecked-type-predicate",
    kind: "correct",
    classification: "ready",
    subproject: "app",
    typeAware: true,
    tsconfig: "tsconfig.json",
    paths: ["src/programs/persistenceCuration.ts"],
  },
  {
    id: "atlas-concept-signals-primitive-predicate-clean",
    ruleId: "antidrift/no-underchecked-type-predicate",
    kind: "correct",
    classification: "ready",
    subproject: "app",
    typeAware: true,
    tsconfig: "tsconfig.json",
    paths: ["src/programs/repoComprehensionSurfaces.ts"],
  },
  {
    id: "atlas-three-material-union-predicate-clean",
    ruleId: "antidrift/no-underchecked-type-predicate",
    kind: "correct",
    classification: "ready",
    subproject: "app",
    typeAware: true,
    tsconfig: "tsconfig.json",
    paths: ["src/needle/AtlasNeedleRenderer.ts"],
  },
  {
    id: "atlas-zod-branded-id-parse-boundary-clean",
    ruleId: "antidrift/no-cast-to-branded",
    kind: "correct",
    classification: "under-proven",
    subproject: "app",
    typeAware: true,
    tsconfig: "tsconfig.json",
    paths: ["src/services/atlasIdService.ts"],
  },
];

const externalCorpora = [
  {
    name: "sudocode-main",
    label: "Sudocode",
    repoCandidates: sudocodeRepoCandidates,
    cases: sudocodeCases,
  },
  {
    name: "codebase-atlas",
    label: "Codebase Atlas",
    repoCandidates: codebaseAtlasRepoCandidates,
    cases: codebaseAtlasCases,
  },
];

function parseCsv(value) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function normalizeRuleId(rule) {
  if (rule.includes("/")) return rule;
  if (coreRuleIds.has(rule)) return rule;
  return `antidrift/${rule}`;
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseArgs(argv) {
  const out = { repo: null, corpus: null, slice: "external-corpus", output: null, require: false, rules: null, minRepositories: 1 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--repo" && next) {
      out.repo = next;
      i += 1;
    } else if (arg === "--corpus" && next) {
      out.corpus = next;
      i += 1;
    } else if (arg === "--slice" && next) {
      out.slice = next;
      i += 1;
    } else if (arg === "--output" && next) {
      out.output = next;
      i += 1;
    } else if (arg === "--rules" && next) {
      out.rules = parseCsv(next).map(normalizeRuleId);
      i += 1;
    } else if (arg === "--min-repositories" && next) {
      out.minRepositories = parsePositiveInteger(next, out.minRepositories);
      i += 1;
    } else if (arg === "--require") {
      out.require = true;
    }
  }
  return out;
}

function selectedCorpora(corpus) {
  if (!corpus) return externalCorpora;
  return externalCorpora.filter((entry) => entry.name === corpus);
}

function externalSlice(sharedOptions) {
  return sharedOptions.slice ?? "external-corpus";
}

function unknownCorpusSummary(corpus, sharedOptions) {
  return {
    schemaVersion: 1,
    corpus: "external",
    slice: externalSlice(sharedOptions),
    decision: "fail",
    reason: `Unknown external corpus: ${corpus}. Known: ${externalCorpora.map((entry) => entry.name).join(", ")}`,
    repositories: [],
  };
}

function externalDecision({ failed, passed, minRepositories, require }) {
  if (failed) return "fail";
  if (passed >= minRepositories) return "pass";
  if (passed > 0) return "fail";
  if (require) return "fail";
  return "skip";
}

function externalReason({ decision, failed, passed, minRepositories }) {
  if (decision === "skip") return "No external corpus repositories were found. Pass --repo with --corpus or set a matching environment variable.";
  if (!failed && passed > 0 && passed < minRepositories) return `Only ${passed} external corpus repositories passed; ${minRepositories} required for this slice.`;
  return null;
}

function runExternalCorpus(entry, sharedOptions) {
  return runCorpusCases({
    corpus: entry.name,
    corpusLabel: entry.label,
    repoCandidates: entry.repoCandidates,
    cases: entry.cases,
    output: null,
    report: () => {},
    ...sharedOptions,
  });
}

function emitSummary(summary, output, report) {
  const json = `${JSON.stringify(summary, null, 2)}\n`;
  if (output) {
    writeFileSync(resolve(output), json, "utf8");
  } else {
    report(json.trimEnd());
  }
}

export async function externalCorpus(options = {}) {
  const { corpus = null, output = null, report = console.log, minRepositories = 1, ...sharedOptions } = options;
  const corpora = selectedCorpora(corpus);
  if (corpus && corpora.length === 0) {
    const summary = unknownCorpusSummary(corpus, sharedOptions);
    report(JSON.stringify(summary, null, 2));
    return summary;
  }

  const repositories = await Promise.all(corpora.map((entry) => runExternalCorpus(entry, sharedOptions)));

  const passed = repositories.filter((result) => result.decision === "pass").length;
  const failed = repositories.some((result) => result.decision === "fail");
  const decision = externalDecision({ failed, passed, minRepositories, require: sharedOptions.require });
  const reason = externalReason({ decision, failed, passed, minRepositories });
  const summary = {
    schemaVersion: 1,
    corpus: "external",
    slice: externalSlice(sharedOptions),
    decision,
    minRepositories,
    repositories,
  };
  if (reason) summary.reason = reason;
  emitSummary(summary, output, report);
  return summary;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await externalCorpus(parseArgs(process.argv.slice(2)));
  if (result.decision === "fail") process.exitCode = 1;
}

export { parseArgs, sudocodeCases, codebaseAtlasCases };
