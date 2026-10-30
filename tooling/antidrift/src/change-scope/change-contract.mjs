import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import { analyzeChangeScope } from "./analyze.mjs";
import { collectChangeSurface } from "./change-context.mjs";
import { parseContract } from "./contract-schema.mjs";
import { collectTouchedModuleGraph } from "./module-graph.mjs";

export const CHANGE_CONTRACT_CLAIM =
  "the diff exceeded the declared scope contract";

function contractStateFor(contractRelativePath, surface) {
  const match = surface.changedFiles.find(
    (file) =>
      file.path === contractRelativePath ||
      file.oldPath === contractRelativePath
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

function contractAt(resolvedContract, { contractPath, base, requireContract }) {
  if (!existsSync(resolvedContract)) {
    if (requireContract) {
      throw new Error(`change contract not found: ${contractPath}`);
    }
    return null;
  }
  const contract = parseContract(readFileSync(resolvedContract, "utf8"));
  if (typeof base !== "string" || base.length === 0) {
    throw new Error(
      "change-contract: a base ref is required when a contract is present (pass --base or ANTIDRIFT_BASE_REF)"
    );
  }
  return contract;
}

function missingContractResult() {
  return {
    contractState: "missing",
    claim: CHANGE_CONTRACT_CLAIM,
    changeContext: null,
    declaredScope: null,
    actualChangeSurface: null,
    violations: [],
    decision: "inventory",
  };
}

function touchedModuleGraphFor(scope, changedFiles, { cwd, head, tsconfig }) {
  const configured = moduleGraphConfigured(scope);
  if (configured && scope.allowedEntrypoints.length === 0) {
    throw new Error(
      "change-contract: scope.allowedEntrypoints is required when scope.maxTouchedModuleRadius is configured"
    );
  }
  return configured
    ? collectTouchedModuleGraph({
        cwd,
        head,
        tsconfig,
        changedFiles,
        allowedEntrypoints: scope.allowedEntrypoints,
        maxTouchedModuleRadius: scope.maxTouchedModuleRadius,
      })
    : null;
}

function actualChangeSurfaceOf(surface, touchedModuleGraph) {
  return {
    changedFiles: surface.changedFiles,
    addedExports: surface.addedExports,
    removedExports: surface.removedExports,
    addedRuntimeDependencies: surface.addedRuntimeDependencies,
    addedDevDependencies: surface.addedDevDependencies,
    touchedModuleGraph,
  };
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
  const contract = contractAt(resolvedContract, {
    contractPath,
    base,
    requireContract,
  });
  if (contract === null) return missingContractResult();
  const surface = collectChangeSurface({
    base,
    head,
    cwd,
    includeExports: contract.scope.checkedSurfaces.includes("exports"),
    includePatchHunks: false,
  });
  const violations = analyzeChangeScope(contract, surface);
  const touchedModuleGraph = touchedModuleGraphFor(
    contract.scope,
    surface.changedFiles,
    { cwd, head, tsconfig }
  );
  return {
    contractState: contractStateFor(relative(cwd, resolvedContract), surface),
    claim: CHANGE_CONTRACT_CLAIM,
    changeContext: { base, head, mergeBase: surface.mergeBase },
    declaredScope: contract.scope,
    actualChangeSurface: actualChangeSurfaceOf(surface, touchedModuleGraph),
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

export function changeContractCommand(argv) {
  const parsed = parseArgs(argv);
  if (parsed.mode !== "inventory") {
    console.error(
      `change-contract: --mode ${parsed.mode} is not available in v0 (inventory-only).`
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
      `${JSON.stringify(result, null, 2)}\n`
    );
  }
  if (result.contractState === "missing") {
    process.stdout.write(
      `change-contract: no contract at ${parsed.contractPath}; inventory-only (exit 0).\n`
    );
  } else {
    process.stdout.write(
      `change-contract ${result.contractState}: ${result.violations.length} violation(s), inventory-only.\n`
    );
  }
  return result;
}
