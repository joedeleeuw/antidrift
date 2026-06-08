import { readFileSync } from "node:fs";
import { join } from "node:path";

import YAML from "yaml";

// Registries are optional. A registry that is not present means "no rules of that kind configured"
// (the registry-driven rules go inert on an empty object), so a missing file resolves to {}. A file
// that exists but is malformed is a real error and is allowed to throw — we don't paper over broken
// config to keep a lint run green.
function loadOne(policyDir, name) {
  let text;
  try {
    text = readFileSync(join(policyDir, "registries", `${name}.yaml`), "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
  return YAML.parse(text) ?? {};
}

export function loadRegistriesSync(policyDir = "policy") {
  return {
    domain: loadOne(policyDir, "domain"),
    gateways: loadOne(policyDir, "gateways"),
    architecture: loadOne(policyDir, "architecture"),
    boundaries: loadOne(policyDir, "boundaries"),
    generated: loadOne(policyDir, "generated"),
  };
}
