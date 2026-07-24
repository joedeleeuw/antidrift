import { isAbsolute, join, resolve, sep } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import YAML from "yaml";
import ts from "typescript";

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
export function readRegistry(policyDir, name, errors) {
  const file = join(policyDir, "registries", `${name}.yaml`);
  if (!existsSync(file)) {
    return {};
  }
  try {
    const parsed = YAML.parse(readFileSync(file, "utf8")) ?? {};
    if (!isRecord(parsed)) {
      errors.push(`policy/registries/${name}.yaml must contain a mapping.`);
      return {};
    }
    return parsed;
  } catch (error) {
    errors.push(
      `policy/registries/${name}.yaml could not be parsed: ${error.message}`,
    );
    return {};
  }
}
export function readPolicySource(policyDir, errors) {
  const file = join(policyDir, "agent-guardrails.yaml");
  if (!existsSync(file)) {
    return null;
  }
  try {
    const parsed = YAML.parse(readFileSync(file, "utf8")) ?? {};
    if (!isRecord(parsed)) {
      errors.push("policy/agent-guardrails.yaml must contain a mapping.");
      return null;
    }
    return parsed;
  } catch (error) {
    errors.push(
      `policy/agent-guardrails.yaml could not be parsed: ${error.message}`,
    );
    return null;
  }
}
function stringArray(value, label, errors, { allowEmpty = false } = {}) {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    errors.push(`${label} must be an array of strings.`);
    return [];
  }
  if (!allowEmpty && value.length === 0) {
    errors.push(`${label} must not be empty.`);
  }
  return value;
}
function safeRepoPath(repoRoot, relativePath) {
  if (
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    isAbsolute(relativePath) ||
    /^[A-Za-z]:[\\/]/u.test(relativePath)
  ) {
    return null;
  }
  const root = resolve(repoRoot);
  const target = resolve(root, relativePath);
  return target.startsWith(root + sep) ? target : null;
}
function requireExistingPath(repoRoot, relativePath, label, errors) {
  const target = safeRepoPath(repoRoot, relativePath);
  if (!target) {
    errors.push(`${label} must be a relative repo path.`);
    return;
  }
  if (!existsSync(target)) {
    errors.push(`${label} path does not exist: ${relativePath}`);
  }
}
function unwrapExpression(node) {
  let current = node;
  while (ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) {
    current = current.expression;
  }
  return current;
}
function findExportedConst(sourceFile, exportName) {
  for (const statement of sourceFile.statements) {
    const isExported = statement.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    );
    if (!isExported || !ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(declaration.name) ||
        declaration.name.text !== exportName ||
        !declaration.initializer
      ) {
        continue;
      }
      return declaration;
    }
  }
  return null;
}
function arrayLiteralStrings(initializer, exportName, label, errors) {
  const expression = unwrapExpression(initializer);
  if (!ts.isArrayLiteralExpression(expression)) {
    errors.push(
      `${label} valuesExport '${exportName}' must be an exported string array.`,
    );
    return null;
  }
  const values = [];
  for (const element of expression.elements) {
    if (
      !ts.isStringLiteral(element) &&
      !ts.isNoSubstitutionTemplateLiteral(element)
    ) {
      errors.push(
        `${label} valuesExport '${exportName}' must contain only string literals.`,
      );
      return null;
    }
    values.push(element.text);
  }
  return values;
}
function exportedStringArray(
  repoRoot,
  relativePath,
  exportName,
  label,
  errors,
) {
  const target = safeRepoPath(repoRoot, relativePath);
  if (!target || !existsSync(target)) {
    return null;
  }
  const source = readFileSync(target, "utf8");
  const sourceFile = ts.createSourceFile(
    target,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const declaration = findExportedConst(sourceFile, exportName);
  if (declaration?.initializer) {
    return arrayLiteralStrings(
      declaration.initializer,
      exportName,
      label,
      errors,
    );
  }
  errors.push(
    `${label} valuesExport '${exportName}' was not found in ${relativePath}.`,
  );
  return null;
}
function requireMatchingValueExport(
  repoRoot,
  owner,
  exportName,
  values,
  label,
  errors,
) {
  if (exportName === undefined) {
    return;
  }
  if (typeof exportName !== "string" || exportName.length === 0) {
    errors.push(`${label}.valuesExport must be a string.`);
    return;
  }
  const exported = exportedStringArray(
    repoRoot,
    owner,
    exportName,
    label,
    errors,
  );
  if (!exported) {
    return;
  }
  if (
    values.length !== exported.length ||
    values.some((value, index) => value !== exported[index])
  ) {
    errors.push(
      `${label}.values must match exported ${exportName}: [${exported.join(", ")}]`,
    );
  }
}
function checkCanonicalEntities(entities, repoRoot, errors) {
  if (entities === undefined) {
    return;
  }
  if (!isRecord(entities)) {
    errors.push(
      "policy/registries/domain.yaml canonicalEntities must be a mapping.",
    );
    return;
  }
  for (const [name, owner] of Object.entries(entities)) {
    requireExistingPath(
      repoRoot,
      owner,
      `policy/registries/domain.yaml canonicalEntities.${name}`,
      errors,
    );
  }
}
function checkStatuses(statuses, repoRoot, errors) {
  if (statuses === undefined) {
    return;
  }
  if (!isRecord(statuses)) {
    errors.push("policy/registries/domain.yaml statuses must be a mapping.");
    return;
  }
  for (const [name, entry] of Object.entries(statuses)) {
    if (!isRecord(entry)) {
      errors.push(
        `policy/registries/domain.yaml statuses.${name} must be a mapping.`,
      );
      continue;
    }
    requireExistingPath(
      repoRoot,
      entry.owner,
      `policy/registries/domain.yaml statuses.${name}.owner`,
      errors,
    );
    const values = stringArray(
      entry.values,
      `policy/registries/domain.yaml statuses.${name}.values`,
      errors,
    );
    requireMatchingValueExport(
      repoRoot,
      entry.owner,
      entry.valuesExport,
      values,
      `policy/registries/domain.yaml statuses.${name}`,
      errors,
    );
  }
}
function checkRoles(roles, repoRoot, errors) {
  if (roles === undefined) {
    return;
  }
  if (!isRecord(roles)) {
    errors.push("policy/registries/domain.yaml roles must be a mapping.");
    return;
  }
  requireExistingPath(
    repoRoot,
    roles.owner,
    "policy/registries/domain.yaml roles.owner",
    errors,
  );
  const values = stringArray(
    roles.values,
    "policy/registries/domain.yaml roles.values",
    errors,
  );
  requireMatchingValueExport(
    repoRoot,
    roles.owner,
    roles.valuesExport,
    values,
    "policy/registries/domain.yaml roles",
    errors,
  );
}
function checkDomain(registry, repoRoot, errors) {
  checkCanonicalEntities(registry.canonicalEntities, repoRoot, errors);
  checkStatuses(registry.statuses, repoRoot, errors);
  checkRoles(registry.roles, repoRoot, errors);
}
function checkGateways(registry, repoRoot, errors) {
  if (registry.approvedGateways === undefined) {
    return;
  }
  if (!isRecord(registry.approvedGateways)) {
    errors.push(
      "policy/registries/gateways.yaml approvedGateways must be a mapping.",
    );
    return;
  }
  for (const [name, entry] of Object.entries(registry.approvedGateways)) {
    if (!isRecord(entry)) {
      errors.push(
        `policy/registries/gateways.yaml approvedGateways.${name} must be a mapping.`,
      );
      continue;
    }
    requireExistingPath(
      repoRoot,
      entry.wrapper,
      `policy/registries/gateways.yaml approvedGateways.${name}.wrapper`,
      errors,
    );
    stringArray(
      entry.bannedDirectImports,
      `policy/registries/gateways.yaml approvedGateways.${name}.bannedDirectImports`,
      errors,
    );
  }
}
function checkGenerated(registry, repoRoot, errors) {
  if (registry.generatedSources === undefined) {
    return;
  }
  if (!isRecord(registry.generatedSources)) {
    errors.push(
      "policy/registries/generated.yaml generatedSources must be a mapping.",
    );
    return;
  }
  for (const [name, entry] of Object.entries(registry.generatedSources)) {
    if (!isRecord(entry)) {
      errors.push(
        `policy/registries/generated.yaml generatedSources.${name} must be a mapping.`,
      );
      continue;
    }
    if (typeof entry.generated !== "string" || entry.generated.length === 0) {
      errors.push(
        `policy/registries/generated.yaml generatedSources.${name}.generated must be a non-empty string.`,
      );
    } else {
      requireExistingPath(
        repoRoot,
        entry.generated,
        `policy/registries/generated.yaml generatedSources.${name}.generated`,
        errors,
      );
    }
    if (entry.wrapper !== undefined) {
      requireExistingPath(
        repoRoot,
        entry.wrapper,
        `policy/registries/generated.yaml generatedSources.${name}.wrapper`,
        errors,
      );
    }
    if (entry.bannedDirectImports !== undefined) {
      stringArray(
        entry.bannedDirectImports,
        `policy/registries/generated.yaml generatedSources.${name}.bannedDirectImports`,
        errors,
        { allowEmpty: true },
      );
    }
  }
}
function checkOwnership(registry, errors) {
  if (registry.packageTypeOwners === undefined) {
    return;
  }
  if (!isRecord(registry.packageTypeOwners)) {
    errors.push(
      "policy/registries/ownership.yaml packageTypeOwners must be a mapping.",
    );
    return;
  }
  for (const [name, entry] of Object.entries(registry.packageTypeOwners)) {
    if (!isRecord(entry)) {
      errors.push(
        `policy/registries/ownership.yaml packageTypeOwners.${name} must be a mapping.`,
      );
      continue;
    }
    for (const key of ["package", "exportName", "reason"]) {
      if (typeof entry[key] !== "string" || entry[key].length === 0) {
        errors.push(
          `policy/registries/ownership.yaml packageTypeOwners.${name}.${key} must be a non-empty string.`,
        );
      }
    }
  }
}
function checkArchitectureLayers(layers, errors) {
  if (layers === undefined) {
    return;
  }
  if (!isRecord(layers)) {
    errors.push(
      "policy/registries/architecture.yaml layers must be a mapping.",
    );
    return;
  }
  const layerNames = new Set(Object.keys(layers));
  for (const [name, entry] of Object.entries(layers)) {
    if (!isRecord(entry)) {
      errors.push(
        `policy/registries/architecture.yaml layers.${name} must be a mapping.`,
      );
      continue;
    }
    stringArray(
      entry.roots,
      `policy/registries/architecture.yaml layers.${name}.roots`,
      errors,
    );
    for (const target of stringArray(
      entry.mayImport ?? [],
      `policy/registries/architecture.yaml layers.${name}.mayImport`,
      errors,
      { allowEmpty: true },
    )) {
      if (!layerNames.has(target)) {
        errors.push(
          `policy/registries/architecture.yaml layers.${name}.mayImport references unknown layer: ${target}`,
        );
      }
    }
  }
}
function checkForbiddenImports(forbiddenImports, errors) {
  if (forbiddenImports === undefined) {
    return;
  }
  if (!Array.isArray(forbiddenImports)) {
    errors.push(
      "policy/registries/architecture.yaml forbiddenImports must be an array.",
    );
    return;
  }
  for (const [index, entry] of forbiddenImports.entries()) {
    if (
      !isRecord(entry) ||
      typeof entry.from !== "string" ||
      typeof entry.to !== "string"
    ) {
      errors.push(
        `policy/registries/architecture.yaml forbiddenImports.${index} must contain from and to strings.`,
      );
    }
  }
}
function checkArchitecture(registry, errors) {
  checkArchitectureLayers(registry.layers, errors);
  if (registry.publicEntrypoints !== undefined) {
    stringArray(
      registry.publicEntrypoints,
      "policy/registries/architecture.yaml publicEntrypoints",
      errors,
      { allowEmpty: true },
    );
  }
  checkForbiddenImports(registry.forbiddenImports, errors);
}
function checkBoundaries(registry, errors) {
  if (registry.serverBoundaryGlobs !== undefined) {
    stringArray(
      registry.serverBoundaryGlobs,
      "policy/registries/boundaries.yaml serverBoundaryGlobs",
      errors,
    );
  }
  if (registry.requiredCalls === undefined) {
    return;
  }
  if (!isRecord(registry.requiredCalls)) {
    errors.push(
      "policy/registries/boundaries.yaml requiredCalls must be a mapping.",
    );
    return;
  }
  for (const [name, calls] of Object.entries(registry.requiredCalls)) {
    stringArray(
      calls,
      `policy/registries/boundaries.yaml requiredCalls.${name}`,
      errors,
    );
  }
}
function checkDependencies(registry, repoRoot, errors) {
  const policy = registry.runtimeDependencyPolicy;
  if (policy === undefined) {
    return;
  }
  if (!isRecord(policy)) {
    errors.push(
      "policy/registries/dependencies.yaml runtimeDependencyPolicy must be a mapping.",
    );
    return;
  }
  if (policy.requireApproval === true) {
    requireExistingPath(
      repoRoot,
      policy.approvalFile,
      "policy/registries/dependencies.yaml runtimeDependencyPolicy.approvalFile",
      errors,
    );
  }
  stringArray(
    policy.bannedVersionSpecifiers,
    "policy/registries/dependencies.yaml runtimeDependencyPolicy.bannedVersionSpecifiers",
    errors,
  );
}
function checkDesignSystem(registry, errors) {
  if (registry.semanticClassPrefixes !== undefined) {
    stringArray(
      registry.semanticClassPrefixes,
      "policy/registries/design-system.yaml semanticClassPrefixes",
      errors,
    );
  }
  for (const key of [
    "bannedRawTailwindColorPattern",
    "bannedHoverTranslatePattern",
  ]) {
    if (registry[key] === undefined) {
      continue;
    }
    if (typeof registry[key] !== "string") {
      errors.push(
        `policy/registries/design-system.yaml ${key} must be a string.`,
      );
      continue;
    }
    try {
      new RegExp(registry[key], "u");
    } catch (error) {
      errors.push(
        `policy/registries/design-system.yaml ${key} is not a valid regex: ${error.message}`,
      );
    }
  }
  if (registry.genericAiCopy !== undefined) {
    stringArray(
      registry.genericAiCopy,
      "policy/registries/design-system.yaml genericAiCopy",
      errors,
      { allowEmpty: true },
    );
  }
}
export function checkDomainRegistries(registries, repoRoot, errors) {
  checkArchitecture(registries.architecture, errors);
  checkBoundaries(registries.boundaries, errors);
  checkDependencies(registries.dependencies, repoRoot, errors);
  checkDesignSystem(registries.designSystem, errors);
  checkDomain(registries.domain, repoRoot, errors);
  checkGateways(registries.gateways, repoRoot, errors);
  checkGenerated(registries.generated, repoRoot, errors);
  checkOwnership(registries.ownership, errors);
}
