import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import { analyzeChangeScope } from "./analyze.mjs";
import { collectChangeSurface } from "./change-context.mjs";
import { parseContract } from "./contract-schema.mjs";
import { collectTouchedModuleGraph } from "./module-graph.mjs";
import {
  semanticFact,
  semanticFactToJsonLine,
} from "../policy/lib/semantic-facts.mjs";

export const CHANGE_CONTRACT_CLAIM =
  "the diff exceeded the declared scope contract";

/**
 * Build the inventory-only semantic fact for a change-contract conformance result.
 * @param {ReturnType<typeof runChangeContract>} result
 * @param {string} contractPath
 */
export function changeContractFact(result, contractPath) {
  return semanticFact({
    factKind: "changeContractConformance",
    ruleId: "antidrift/change-contract-conformance",
    adapterId: "change-contract",
    confidence: "deterministic-inventory",
    provenance: [
      "change-contract",
      "git-diff",
      "package-manifest",
      "ts-program",
    ],
    filePath: contractPath,
    payload: {
      contractState: result.contractState,
      changeContext: result.changeContext,
      declaredScope: result.declaredScope,
      actualChangeSurface: result.actualChangeSurface,
      violations: result.violations,
      decision: result.decision,
    },
  });
}

function contractStateFor(contractRelativePath, changedFiles) {
  const match = changedFiles.find(
    (file) =>
      file.path === contractRelativePath ||
      file.oldPath === contractRelativePath,
  );
  if (!match) return "present";
  return match.operation === "add" ? "new-in-diff" : "modified-in-diff";
}

function moduleGraphConfigured(scope) {
  return (
    scope.allowedEntrypoints.length > 0 ||
    typeof scope.maxTouchedModuleRadius === "number"
  );
}

function surfaceConfigured(scope, surface) {
  return scope.checkedSurfaces.includes(surface);
}

function touchedModuleGraphFor({ contract, surface, cwd, head, tsconfig }) {
  if (!moduleGraphConfigured(contract.scope)) return null;
  if (contract.scope.allowedEntrypoints.length === 0) {
    throw new Error(
      "change-contract: scope.allowedEntrypoints is required when scope.maxTouchedModuleRadius is configured",
    );
  }
  return collectTouchedModuleGraph({
    cwd,
    head,
    tsconfig,
    changedFiles: surface.changedFiles,
    allowedEntrypoints: contract.scope.allowedEntrypoints,
    maxTouchedModuleRadius: contract.scope.maxTouchedModuleRadius,
  });
}

/**
 * Inventory-only (v0): never blocks. A missing contract is not a failure; an invalid contract throws
 * loudly (ContractValidationError). Violations are reported, not enforced.
 * @param {{ contractPath: string, base: string, head: string, cwd: string, tsconfig?: string | null, requireContract?: boolean }} params
 */
export function runChangeContract({
  contractPath,
  base,
  head,
  cwd,
  tsconfig = null,
  requireContract = false,
}) {
  const resolvedContract = isAbsolute(contractPath)
    ? contractPath
    : resolve(cwd, contractPath);

  if (!existsSync(resolvedContract)) {
    if (requireContract) {
      throw new Error(`change contract not found: ${contractPath}`);
    }
    return {
      contractState: "missing",
      claim: CHANGE_CONTRACT_CLAIM,
      contractId: null,
      changeContext: null,
      declaredScope: null,
      actualChangeSurface: null,
      violations: [],
      decision: "inventory",
    };
  }

  const contract = parseContract(readFileSync(resolvedContract, "utf8"));
  if (typeof base !== "string" || base.length === 0) {
    throw new Error(
      "change-contract: a base ref is required when a contract is present (pass --base or ANTIDRIFT_BASE_REF)",
    );
  }
  const surface = collectChangeSurface({
    base,
    head,
    cwd,
    includeExports: surfaceConfigured(contract.scope, "exports"),
    includePatchHunks: false,
  });
  const contractState = contractStateFor(
    relative(cwd, resolvedContract),
    surface.changedFiles,
  );
  const violations = analyzeChangeScope(contract, surface);
  const touchedModuleGraph = touchedModuleGraphFor({
    contract,
    surface,
    cwd,
    head,
    tsconfig,
  });

  return {
    contractState,
    claim: CHANGE_CONTRACT_CLAIM,
    contractId: contract.contractId,
    changeContext: { base, head, mergeBase: surface.mergeBase },
    declaredScope: contract.scope,
    actualChangeSurface: {
      changedFiles: surface.changedFiles,
      addedExports: surface.addedExports,
      removedExports: surface.removedExports,
      addedRuntimeDependencies: surface.addedRuntimeDependencies,
      addedDevDependencies: surface.addedDevDependencies,
      touchedModuleGraph,
    },
    violations,
    decision: "inventory",
  };
}

const CHANGE_CONTRACT_VALUE_FLAGS = Object.freeze({
  "--contract": "contractPath",
  "--base": "base",
  "--head": "head",
  "--tsconfig": "tsconfig",
  "--output": "output",
  "--facts-out": "factsOut",
  "--mode": "mode",
});

export function parseArgs(argv) {
  const parsed = {
    contractPath:
      process.env.ANTIDRIFT_CHANGE_CONTRACT ??
      ".antidrift/change-contract.yaml",
    base: process.env.ANTIDRIFT_BASE_REF ?? null,
    head: "HEAD",
    cwd: process.cwd(),
    tsconfig: null,
    output: null,
    factsOut: null,
    requireContract: false,
    mode: "inventory",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--require-contract") {
      parsed.requireContract = true;
      continue;
    }
    const key = CHANGE_CONTRACT_VALUE_FLAGS[arg];
    if (key === undefined) {
      throw new Error(`change-contract: unknown argument "${arg}"`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`change-contract: ${arg} requires a value`);
    }
    parsed[key] = value;
    index += 1;
  }
  return parsed;
}

/**
 * CLI entry: inventory-only (v0). Missing contract exits 0; invalid contract or a present contract
 * without a base ref fails loudly. Violations are reported, never enforced.
 * @param {string[]} argv
 */
export function changeContractCommand(argv) {
  const parsed = parseArgs(argv);
  if (parsed.mode !== "inventory") {
    console.error(
      `change-contract: --mode ${parsed.mode} is not available in v0 (inventory-only).`,
    );
    process.exitCode = 1;
    return null;
  }
  const result = runChangeContract({
    contractPath: parsed.contractPath,
    base: parsed.base,
    head: parsed.head,
    cwd: parsed.cwd,
    tsconfig: parsed.tsconfig,
    requireContract: parsed.requireContract,
  });
  if (parsed.output) {
    writeFileSync(
      resolve(parsed.cwd, parsed.output),
      `${JSON.stringify(result, null, 2)}\n`,
    );
  }
  if (parsed.factsOut && result.contractState !== "missing") {
    writeFileSync(
      resolve(parsed.cwd, parsed.factsOut),
      semanticFactToJsonLine(changeContractFact(result, parsed.contractPath)),
    );
  }
  if (result.contractState === "missing") {
    process.stdout.write(
      `change-contract: no contract at ${parsed.contractPath}; inventory-only (exit 0).\n`,
    );
  } else {
    process.stdout.write(
      `change-contract [${result.contractId}] ${result.contractState}: ${result.violations.length} violation(s), inventory-only.\n`,
    );
  }
  return result;
}
