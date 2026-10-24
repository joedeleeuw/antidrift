import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SEMANTIC_ADAPTER_CONTRACTS } from "../../src/semantic-adapters/index.mjs";
import { SEMANTIC_FACT_KINDS } from "../../src/policy/lib/semantic-facts.mjs";

export function workspace() {
  const root = mkdtempSync(join(tmpdir(), "antidrift-registries-"));
  mkdirSync(join(root, "policy", "registries"), { recursive: true });
  return root;
}
export function writeRegistry(root, name, text) {
  writeFileSync(join(root, "policy", "registries", `${name}.yaml`), text);
}
export function touch(root, file) {
  mkdirSync(join(root, file, ".."), { recursive: true });
  writeFileSync(join(root, file), "");
}
export function writePackageJson(root, contents) {
  mkdirSync(join(root, "tooling", "antidrift"), { recursive: true });
  writeFileSync(
    join(root, "tooling", "antidrift", "package.json"),
    `${JSON.stringify(contents, null, 2)}\n`
  );
}
export function semanticAdapterPackageExports() {
  const exports = {
    "./semantic-adapters": {
      types: "./src/semantic-adapters/index.d.mts",
      import: "./src/semantic-adapters/index.mjs",
    },
  };
  for (const contract of Object.values(SEMANTIC_ADAPTER_CONTRACTS)) {
    exports[`./semantic-adapters/${contract.id}`] = {
      types: `./src/semantic-adapters/${contract.id}.d.mts`,
      import: `./src/semantic-adapters/${contract.id}.mjs`,
    };
  }
  return exports;
}
export function semanticAdapterContractKeys() {
  return Object.keys(SEMANTIC_ADAPTER_CONTRACTS).sort((a, b) =>
    a.localeCompare(b)
  );
}
export function semanticAdapterAggregateRuntimeSource(
  keys = semanticAdapterContractKeys()
) {
  return [
    ...keys.map((key) => {
      const id = SEMANTIC_ADAPTER_CONTRACTS[key]?.id ?? key;
      return `import * as ${key} from "./${id}.mjs";`;
    }),
    "",
    "export {",
    ...keys.map((key) => `  ${key},`),
    "};",
    "",
    "export const SEMANTIC_ADAPTERS = Object.freeze({",
    ...keys.map((key) => `  ${key},`),
    "});",
    "",
    "export const SEMANTIC_ADAPTER_CONTRACTS = Object.freeze({});",
    "",
  ].join("\n");
}
export function semanticAdapterAggregateTypeSource(
  keys = semanticAdapterContractKeys()
) {
  return [
    ...keys.map((key) => {
      const id = SEMANTIC_ADAPTER_CONTRACTS[key]?.id ?? key;
      return `import * as ${key} from "./${id}.mjs";`;
    }),
    "",
    "export {",
    ...keys.map((key) => `  ${key},`),
    "};",
    "",
    "export const SEMANTIC_ADAPTERS: Readonly<{",
    ...keys.map((key) => `  ${key}: typeof ${key};`),
    "}>;",
    "",
    "export type SemanticAdapterContractKey =",
    ...keys.map(
      (key, index) =>
        `  | ${JSON.stringify(key)}${index === keys.length - 1 ? ";" : ""}`
    ),
    "",
    "export const SEMANTIC_ADAPTER_CONTRACTS: Readonly<Record<SemanticAdapterContractKey, unknown>>;",
    "",
  ].join("\n");
}
export function writeSemanticAdapterAggregateFiles(root) {
  mkdirSync(join(root, "tooling", "antidrift", "src", "semantic-adapters"), {
    recursive: true,
  });
  writeFileSync(
    join(root, "tooling", "antidrift", "src", "semantic-adapters", "index.mjs"),
    semanticAdapterAggregateRuntimeSource()
  );
  writeFileSync(
    join(
      root,
      "tooling",
      "antidrift",
      "src",
      "semantic-adapters",
      "index.d.mts"
    ),
    semanticAdapterAggregateTypeSource()
  );
}
export function touchSemanticAdapterPackageExportFiles(root) {
  writeSemanticAdapterAggregateFiles(root);
  for (const contract of Object.values(SEMANTIC_ADAPTER_CONTRACTS)) {
    touch(root, `tooling/antidrift/src/semantic-adapters/${contract.id}.d.mts`);
    touch(root, `tooling/antidrift/src/semantic-adapters/${contract.id}.mjs`);
  }
}
export function yamlFlowStrings(values) {
  return `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;
}
export function replaceYamlSectionField(text, sectionName, fieldName, value) {
  const lines = text.split("\n");
  let inSection = false;
  for (const [index, line] of lines.entries()) {
    if (line === `  ${sectionName}:`) {
      inSection = true;
      continue;
    }
    if (inSection && line.startsWith("  ") && !line.startsWith("    ")) {
      break;
    }
    if (inSection && line.startsWith(`    ${fieldName}: `)) {
      lines[index] = `    ${fieldName}: ${value}`;
      break;
    }
  }
  return lines.join("\n");
}
export function semanticFactKindSections() {
  const entries = Object.entries(SEMANTIC_FACT_KINDS)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([factKind, contract]) => {
      const commandIdsLine = contract.commandIds
        ? `    commandIds: ${yamlFlowStrings(contract.commandIds)}\n`
        : "";
      return `  ${factKind}:
    rules: ${yamlFlowStrings(contract.rules)}
${commandIdsLine}    adapterId: ${contract.adapterId}
    carrier: ${contract.carrier}
    confidence: ${yamlFlowStrings(contract.confidence)}
    emission: ${yamlFlowStrings(contract.emission)}
    association: ${JSON.stringify(contract.association)}
    noSinkBehavior: ${JSON.stringify(contract.noSinkBehavior)}
    payloadFields: ${yamlFlowStrings(contract.payloadFields)}
`;
    })
    .join("");
  return `semanticFactKinds:
${entries}`;
}
const retiredRuleIds = [
  "antidrift/no-cycle",
  "antidrift/no-inline-disable-without-ticket",
  "antidrift/no-sdk-direct-use",
  "antidrift/no-explicit-return-type-private-helper",
  "antidrift/no-silent-catch",
  "antidrift/no-thin-typed-factory-wrapper",
  "antidrift/no-obvious-comment",
  "antidrift/no-role-literal-in-type",
  "antidrift/no-cast-to-branded",
  "antidrift/no-status-triplet-state",
];

export function writeValidRulesRegistry(root) {
  const retiredRules = retiredRuleIds
    .map(
      (rule) => `  ${rule}:
    status: retired
    reason: Test retired decision.
`
    )
    .join("");
  writeRegistry(
    root,
    "rules",
    `schemaVersion: 1
${semanticFactKindSections()}
retiredRules:
${retiredRules}`
  );
}
