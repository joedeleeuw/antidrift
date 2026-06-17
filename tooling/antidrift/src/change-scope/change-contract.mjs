import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import { analyzeChangeScope } from "./analyze.mjs";
import { collectChangeSurface } from "./change-context.mjs";
import { parseContract } from "./contract-schema.mjs";
import { semanticFact } from "../policy/lib/semantic-facts.mjs";

export const CHANGE_CONTRACT_CLAIM = "the diff exceeded the declared scope contract";

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
    provenance: ["change-contract", "git-diff", "package-manifest"],
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
    (file) => file.path === contractRelativePath || file.oldPath === contractRelativePath,
  );
  if (!match) return "present";
  return match.operation === "add" ? "new-in-diff" : "modified-in-diff";
}

/**
 * Inventory-only (v0): never blocks. A missing contract is not a failure; an invalid contract throws
 * loudly (ContractValidationError). Violations are reported, not enforced.
 * @param {{ contractPath: string, base: string, head: string, cwd: string, requireContract?: boolean }} params
 */
export function runChangeContract({ contractPath, base, head, cwd, requireContract = false }) {
  const resolvedContract = isAbsolute(contractPath) ? contractPath : resolve(cwd, contractPath);

  if (!existsSync(resolvedContract)) {
    if (requireContract) throw new Error(`change contract not found: ${contractPath}`);
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
  const surface = collectChangeSurface({ base, head, cwd });
  const contractState = contractStateFor(relative(cwd, resolvedContract), surface.changedFiles);
  const violations = analyzeChangeScope(contract, surface);

  return {
    contractState,
    claim: CHANGE_CONTRACT_CLAIM,
    contractId: contract.contractId,
    changeContext: { base, head, mergeBase: surface.mergeBase },
    declaredScope: contract.scope,
    actualChangeSurface: {
      changedFiles: surface.changedFiles,
      addedRuntimeDependencies: surface.addedRuntimeDependencies,
      addedDevDependencies: surface.addedDevDependencies,
    },
    violations,
    decision: "inventory",
  };
}
