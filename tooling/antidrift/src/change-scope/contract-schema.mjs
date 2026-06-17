import { parse as parseYaml } from "yaml";

const TOP_LEVEL_KEYS = new Set([
  "schemaVersion",
  "contractId",
  "task",
  "authorship",
  "scope",
  "refactor",
]);
const SCOPE_KEYS = new Set([
  "allowedPaths",
  "forbiddenPaths",
  "allowedChangeTypes",
  "allowedExports",
  "allowedRuntimeDependencies",
  "allowedDevDependencies",
  "allowedEntrypoints",
  "maxTouchedModuleRadius",
  "allowedOwnerSymbols",
]);
const CHANGE_TYPES = new Set(["add", "modify", "delete", "rename"]);
const EXPORT_KINDS = new Set(["value", "type", "default", "namespace"]);
const BROAD_GLOBS = new Set(["*", "**", "**/*", "**/**", "/**"]);
const DEPENDENCY_FIELDS = [
  "allowedRuntimeDependencies",
  "allowedDevDependencies",
];

export class ContractValidationError extends Error {
  /** @param {string[]} problems */
  constructor(problems) {
    super(`invalid change contract:\n- ${problems.join("\n- ")}`);
    this.name = "ContractValidationError";
    this.problems = problems;
  }
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value) {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function frozenStringArray(value) {
  return Object.freeze(isStringArray(value) ? [...value] : []);
}

function frozenAllowedExports(value) {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(
    value.map((entry) =>
      Object.freeze({
        file: entry.file,
        name: entry.name,
        kind: entry.kind,
      }),
    ),
  );
}

function checkPath(path, field, problems) {
  if (path.length === 0) {
    problems.push(`${field} contains an empty path`);
    return;
  }
  if (path.startsWith("/")) {
    problems.push(`${field} path must be repo-relative, not absolute: ${path}`);
  }
  if (path.split("/").includes("..")) {
    problems.push(`${field} path must not contain "..": ${path}`);
  }
}

function validateAllowedPaths(scope, refactorApproved, problems) {
  if (!isStringArray(scope.allowedPaths) || scope.allowedPaths.length === 0) {
    problems.push(
      "scope.allowedPaths must be a non-empty array of repo-relative globs",
    );
    return;
  }
  for (const path of scope.allowedPaths) {
    checkPath(path, "scope.allowedPaths", problems);
    if (BROAD_GLOBS.has(path) && !refactorApproved) {
      problems.push(
        `scope.allowedPaths uses broad glob "${path}" without refactor.approved: true`,
      );
    }
  }
}

function validateUnknownScopeKeys(scope, problems) {
  for (const key of Object.keys(scope)) {
    if (!SCOPE_KEYS.has(key)) problems.push(`scope has unknown key: ${key}`);
  }
}

function validateForbiddenPaths(scope, problems) {
  if (scope.forbiddenPaths === undefined) return;
  if (!isStringArray(scope.forbiddenPaths)) {
    problems.push("scope.forbiddenPaths must be an array of strings");
    return;
  }
  for (const path of scope.forbiddenPaths) {
    checkPath(path, "scope.forbiddenPaths", problems);
  }
}

function validateChangeTypes(scope, problems) {
  if (scope.allowedChangeTypes === undefined) return;
  if (!isStringArray(scope.allowedChangeTypes)) {
    problems.push("scope.allowedChangeTypes must be an array of strings");
    return;
  }
  for (const type of scope.allowedChangeTypes) {
    if (!CHANGE_TYPES.has(type)) {
      problems.push(
        `scope.allowedChangeTypes has invalid value "${type}" (expected add|modify|delete|rename)`,
      );
    }
  }
}

function validateDependencyFields(scope, problems) {
  for (const field of DEPENDENCY_FIELDS) {
    if (scope[field] !== undefined && !isStringArray(scope[field])) {
      problems.push(`scope.${field} must be an array of strings`);
    }
  }
}

function validateExports(scope, problems) {
  if (scope.allowedExports === undefined) return;
  if (!Array.isArray(scope.allowedExports)) {
    problems.push("scope.allowedExports must be an array");
    return;
  }
  for (const entry of scope.allowedExports) {
    if (
      !isObject(entry) ||
      typeof entry.file !== "string" ||
      typeof entry.name !== "string"
    ) {
      problems.push(
        "scope.allowedExports entries must be objects with string file and name",
      );
      continue;
    }
    checkPath(entry.file, "scope.allowedExports.file", problems);
    if (!EXPORT_KINDS.has(entry.kind)) {
      problems.push(
        `scope.allowedExports kind must be one of value|type|default|namespace: ${entry.kind}`,
      );
    }
  }
}

function validateEntrypoints(scope, problems) {
  if (scope.allowedEntrypoints === undefined) return;
  if (!isStringArray(scope.allowedEntrypoints)) {
    problems.push("scope.allowedEntrypoints must be an array of strings");
    return;
  }
  for (const path of scope.allowedEntrypoints) {
    checkPath(path, "scope.allowedEntrypoints", problems);
  }
}

function validateOwnerSymbols(scope, problems) {
  if (
    scope.allowedOwnerSymbols !== undefined &&
    !isStringArray(scope.allowedOwnerSymbols)
  ) {
    problems.push("scope.allowedOwnerSymbols must be an array of strings");
  }
}

function validateModuleRadius(scope, problems) {
  const radius = scope.maxTouchedModuleRadius;
  if (
    radius !== undefined &&
    (typeof radius !== "number" || !Number.isInteger(radius) || radius < 0)
  ) {
    problems.push(
      "scope.maxTouchedModuleRadius must be a non-negative integer",
    );
  }
}

function validateScope(scope, refactorApproved, problems) {
  validateUnknownScopeKeys(scope, problems);
  validateAllowedPaths(scope, refactorApproved, problems);
  validateForbiddenPaths(scope, problems);
  validateChangeTypes(scope, problems);
  validateDependencyFields(scope, problems);
  validateExports(scope, problems);
  validateEntrypoints(scope, problems);
  validateOwnerSymbols(scope, problems);
  validateModuleRadius(scope, problems);
}

function validateRefactor(raw, problems) {
  const refactor = isObject(raw.refactor) ? raw.refactor : {};
  if (
    refactor.approved !== undefined &&
    typeof refactor.approved !== "boolean"
  ) {
    problems.push("refactor.approved must be a boolean");
  }
  if (
    refactor.justification !== undefined &&
    typeof refactor.justification !== "string"
  ) {
    problems.push("refactor.justification must be a string");
  }
  const approved = refactor.approved === true;
  if (
    approved &&
    (typeof refactor.justification !== "string" ||
      refactor.justification.trim().length === 0)
  ) {
    problems.push(
      "refactor.approved: true requires a non-empty refactor.justification",
    );
  }
  return {
    approved,
    justification:
      typeof refactor.justification === "string" ? refactor.justification : "",
  };
}

/**
 * Validate a raw parsed contract object and return a frozen, normalized contract.
 * Throws ContractValidationError (loud) listing every problem; never returns a partial default.
 * @param {unknown} raw
 */
export function validateContract(raw) {
  const problems = [];
  if (!isObject(raw)) {
    throw new ContractValidationError(["contract must be a mapping"]);
  }

  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      problems.push(`unknown top-level key: ${key}`);
    }
  }
  if (raw.schemaVersion !== 1) problems.push("schemaVersion must be 1");
  if (
    typeof raw.contractId !== "string" ||
    raw.contractId.trim().length === 0
  ) {
    problems.push("contractId must be a non-empty string");
  }

  const { approved: refactorApproved, justification } = validateRefactor(
    raw,
    problems,
  );

  if (isObject(raw.scope)) {
    validateScope(raw.scope, refactorApproved, problems);
  } else {
    problems.push("scope is required and must be a mapping");
  }

  if (problems.length > 0) throw new ContractValidationError(problems);

  const scope = raw.scope;
  return Object.freeze({
    schemaVersion: 1,
    contractId: raw.contractId.trim(),
    task: raw.task ?? null,
    authorship: raw.authorship ?? null,
    scope: Object.freeze({
      ...scope,
      allowedPaths: frozenStringArray(scope.allowedPaths),
      forbiddenPaths: frozenStringArray(scope.forbiddenPaths),
      allowedChangeTypes: frozenStringArray(scope.allowedChangeTypes),
      allowedExports: frozenAllowedExports(scope.allowedExports),
      allowedRuntimeDependencies: frozenStringArray(
        scope.allowedRuntimeDependencies,
      ),
      allowedDevDependencies: frozenStringArray(scope.allowedDevDependencies),
    }),
    refactor: Object.freeze({ approved: refactorApproved, justification }),
  });
}

/**
 * Parse contract YAML/JSON text and validate it. Loud failure on unparseable input.
 * @param {string} text
 */
export function parseContract(text) {
  let raw;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw new ContractValidationError([
      `contract is not valid YAML/JSON: ${error.message}`,
    ]);
  }
  return validateContract(raw);
}
