import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkDomainRegistries,
  readRegistry,
} from "./registry-checks/domain.mjs";
import { checkPackageSurface } from "./registry-checks/package-surface.mjs";
import { checkRuleRegistry } from "./registry-checks/rules.mjs";

export function checkRegistries({
  repoRoot = process.cwd(),
  policyDir = join(repoRoot, "policy"),
  report = console.error,
} = {}) {
  const root = resolve(repoRoot);
  const resolvedPolicyDir = resolve(policyDir);
  const errors = [];
  const registries = {
    architecture: readRegistry(resolvedPolicyDir, "architecture", errors),
    boundaries: readRegistry(resolvedPolicyDir, "boundaries", errors),
    dependencies: readRegistry(resolvedPolicyDir, "dependencies", errors),
    designSystem: readRegistry(resolvedPolicyDir, "design-system", errors),
    domain: readRegistry(resolvedPolicyDir, "domain", errors),
    gateways: readRegistry(resolvedPolicyDir, "gateways", errors),
    generated: readRegistry(resolvedPolicyDir, "generated", errors),
    ownership: readRegistry(resolvedPolicyDir, "ownership", errors),
    rules: readRegistry(resolvedPolicyDir, "rules", errors),
  };

  checkDomainRegistries(registries, root, errors);
  checkRuleRegistry(registries.rules, root, errors);
  checkPackageSurface(root, errors);

  for (const error of errors) report(error);
  return errors.length === 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url) && !checkRegistries()) {
  process.exitCode = 1;
}
