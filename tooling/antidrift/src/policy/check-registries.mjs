import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkDomainRegistries,
  readPolicySource,
  readRegistry,
} from "./registry-checks/domain.mjs";
import { checkPackageSurface } from "./registry-checks/package-surface.mjs";
import { checkRuleRegistry } from "./registry-checks/rules.mjs";
import { checkSemanticContracts } from "./registry-checks/semantic-contracts.mjs";

export function checkRegistries({
  repoRoot = process.cwd(),
  policyDir = join(repoRoot, "policy"),
  report = console.error,
} = {}) {
  const errors = [];
  const policySource = readPolicySource(policyDir, errors);
  const registries = {
    architecture: readRegistry(policyDir, "architecture", errors),
    boundaries: readRegistry(policyDir, "boundaries", errors),
    dependencies: readRegistry(policyDir, "dependencies", errors),
    designSystem: readRegistry(policyDir, "design-system", errors),
    domain: readRegistry(policyDir, "domain", errors),
    gateways: readRegistry(policyDir, "gateways", errors),
    generated: readRegistry(policyDir, "generated", errors),
    ownership: readRegistry(policyDir, "ownership", errors),
    rules: readRegistry(policyDir, "rules", errors),
  };

  checkDomainRegistries(registries, repoRoot, errors);
  checkRuleRegistry(registries.rules, repoRoot, policySource, errors);
  checkSemanticContracts(registries.rules, repoRoot, errors);
  checkPackageSurface(repoRoot, errors);

  for (const error of errors) report(error);
  return errors.length === 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url) && !checkRegistries()) {
  process.exitCode = 1;
}
