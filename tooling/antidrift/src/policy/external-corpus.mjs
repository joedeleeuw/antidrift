import { fileURLToPath } from "node:url";
import { runCorpusCases } from "./chaski-corpus.mjs";

const defaultRepoCandidates = [process.env.SUDOCODE_REPO, "/Users/sushi/code/sudocode-main"].filter(Boolean);
const coreRuleIds = new Set(["no-restricted-imports"]);

const defaultCases = [
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

function parseCsv(value) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function normalizeRuleId(rule) {
  if (rule.includes("/")) return rule;
  if (coreRuleIds.has(rule)) return rule;
  return `antidrift/${rule}`;
}

function parseArgs(argv) {
  const out = { repo: null, slice: "external-corpus", output: null, require: false, rules: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--repo" && next) {
      out.repo = next;
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
    } else if (arg === "--require") {
      out.require = true;
    }
  }
  return out;
}

export async function externalCorpus(options = {}) {
  return runCorpusCases({
    corpus: "external",
    corpusLabel: "external",
    repoCandidates: defaultRepoCandidates,
    slice: "external-corpus",
    cases: defaultCases,
    ...options,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await externalCorpus(parseArgs(process.argv.slice(2)));
  if (result.decision === "fail") process.exitCode = 1;
}

export { parseArgs };
