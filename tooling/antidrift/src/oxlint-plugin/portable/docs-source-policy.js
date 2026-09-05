import { relative } from "node:path";
import { packageOwner } from "./package-owner.js";
import { isRuleFile, scopeProperties } from "./scope.js";

const MAX_QUARANTINE_MILLISECONDS = 31 * 24 * 60 * 60 * 1000;
const EXACT_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const parsedExactUtcTimestamp = (value) => {
  if (!EXACT_UTC_TIMESTAMP.test(value)) {
    return null;
  }
  const milliseconds = Date.parse(value);
  return Number.isNaN(milliseconds) ? null : milliseconds;
};
const addClassification = (classifications, dependency, disposition) => {
  const current = classifications.get(dependency);
  if (current === undefined) {
    classifications.set(dependency, [disposition]);
    return;
  }
  current.push(disposition);
};
export const checkDocumentationSourcePolicy = ({
  dependencies,
  exclusions,
  now,
  sources,
}) => {
  const failures = [];
  const classifications = new Map();
  for (const [sourceName, source] of Object.entries(sources)) {
    if (source.dependencies.length === 0) {
      failures.push(`${sourceName} has no covered dependencies.`);
    }
    if (!URL.canParse(source.url)) {
      failures.push(`${sourceName} has an invalid llms.txt URL.`);
    } else {
      const url = new URL(source.url);
      if (url.protocol !== "https:" || !url.pathname.endsWith("/llms.txt")) {
        failures.push(
          `${sourceName} must use an HTTPS URL ending in /llms.txt.`,
        );
      }
    }
    for (const dependency of source.dependencies) {
      addClassification(classifications, dependency, `source ${sourceName}`);
    }
  }
  for (const exclusion of exclusions) {
    addClassification(classifications, exclusion.dependency, "exclusion");
    if (exclusion.explanation.trim().length === 0) {
      failures.push(`${exclusion.dependency} has no exclusion explanation.`);
    }
    const checkedAt = parsedExactUtcTimestamp(exclusion.checkedAt);
    const expiresAt = parsedExactUtcTimestamp(exclusion.expiresAt);
    if (checkedAt === null) {
      failures.push(
        `${exclusion.dependency} has an invalid no-llms-txt checkedAt timestamp.`,
      );
      continue;
    }
    if (expiresAt === null) {
      failures.push(
        `${exclusion.dependency} has an invalid no-llms-txt expiresAt timestamp.`,
      );
      continue;
    }
    if (expiresAt <= checkedAt) {
      failures.push(
        `${exclusion.dependency} has a no-llms-txt quarantine that does not follow its check time.`,
      );
    }
    if (expiresAt - checkedAt > MAX_QUARANTINE_MILLISECONDS) {
      failures.push(
        `${exclusion.dependency} has a no-llms-txt quarantine longer than 31 days.`,
      );
    }
    if (now.getTime() >= expiresAt) {
      failures.push(
        `${exclusion.dependency} has an expired no-llms-txt quarantine (${exclusion.expiresAt}); recheck its canonical documentation.`,
      );
    }
  }
  for (const dependency of dependencies) {
    if (!classifications.has(dependency)) {
      failures.push(
        `${dependency} is a direct dependency without an llms.txt source or explained exclusion.`,
      );
    }
  }
  for (const [dependency, dispositions] of classifications) {
    if (!dependencies.has(dependency)) {
      failures.push(
        `${dependency} is classified by ${dispositions.join(" and ")} but is not a direct dependency.`,
      );
    }
    if (dispositions.length > 1) {
      failures.push(
        `${dependency} is classified by ${dispositions.join(" and ")}.`,
      );
    }
  }
  return failures.toSorted();
};

export default {
  meta: {
    type: "problem",
    schema: [
      {
        type: "object",
        properties: {
          ...scopeProperties,
          policyFile: { type: "string", minLength: 1 },
          dependencies: { type: "array", items: { type: "string" } },
          sources: {
            type: "object",
            additionalProperties: {
              type: "object",
              properties: {
                url: { type: "string" },
                dependencies: { type: "array", items: { type: "string" } },
              },
              required: ["url", "dependencies"],
              additionalProperties: false,
            },
          },
          exclusions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                dependency: { type: "string" },
                explanation: { type: "string" },
                checkedAt: { type: "string" },
                expiresAt: { type: "string" },
              },
              required: ["dependency", "explanation", "checkedAt", "expiresAt"],
              additionalProperties: false,
            },
          },
          now: { type: "string", format: "date-time" },
        },
        additionalProperties: false,
      },
    ],
    messages: { policyFailure: "Documentation registry owner: {{failure}}" },
  },
  create(context) {
    if (!isRuleFile(context)) return {};

    const options = context.options[0] ?? {};
    const filename = context.filename ?? context.getFilename();
    const local = relative(context.cwd ?? process.cwd(), filename).replaceAll(
      "\\",
      "/",
    );
    const policyFile = options.policyFile ?? "docs-sources.mjs";
    if (local !== policyFile) return {};
    const owner = packageOwner(filename);
    return {
      Program(node) {
        const failures = checkDocumentationSourcePolicy({
          dependencies: new Set(
            options.dependencies ??
              Object.keys(owner?.manifest.dependencies ?? {}),
          ),
          sources: options.sources ?? {},
          exclusions: options.exclusions ?? [],
          now: options.now ? new Date(options.now) : new Date(),
        });
        for (const failure of failures) {
          context.report({
            node,
            messageId: "policyFailure",
            data: { failure },
          });
        }
      },
    };
  },
};
