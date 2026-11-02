import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import YAML from "yaml";

// Registries are optional. A registry that is not present means "no rules of that kind configured"
// (the registry-driven rules go inert on an empty object), so a missing file resolves to {}. A file
// that exists but is malformed is a real error and is allowed to throw — we don't paper over broken
// config to keep a lint run green.
function loadOne(policyDir, name) {
  const file = join(policyDir, "registries", `${name}.yaml`);
  if (!existsSync(file)) return {};
  return YAML.parse(readFileSync(file, "utf8")) ?? {};
}

export const REGISTRY_FILES = {
  architecture: "architecture",
  boundaries: "boundaries",
  domain: "domain",
  gateways: "gateways",
  generated: "generated",
  reactNative: "react-native",
};

export function loadRegistriesSync(policyDir = "policy") {
  return Object.fromEntries(
    Object.entries(REGISTRY_FILES).map(([key, file]) => [
      key,
      loadOne(policyDir, file),
    ])
  );
}
