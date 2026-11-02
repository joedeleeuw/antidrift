import { isAbsolute, join, resolve, sep } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import YAML from "yaml";
import ts from "typescript";

export function isRecord(value) {
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
      `policy/registries/${name}.yaml could not be parsed: ${error.message}`
    );
    return {};
  }
}

export function stringArray(value, label, errors, { allowEmpty = false } = {}) {
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

function safeRepoPath(root, relativePath) {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    return null;
  }
  const normalized = relativePath
    .replaceAll("\\", "/")
    .replace(/^\.\//u, "")
    .replace(/\/+$/u, "");
  if (
    normalized.length === 0 ||
    isAbsolute(normalized) ||
    /^[A-Za-z]:\//u.test(normalized) ||
    /[!*?{}()[\]]/u.test(normalized) ||
    normalized
      .split("/")
      .some(
        (segment) => segment.length === 0 || segment === "." || segment === ".."
      )
  ) {
    return null;
  }
  const target = resolve(root, normalized);
  return target.startsWith(root + sep) ? target : null;
}

export function requireExistingPath(root, relativePath, label, errors) {
  const target = safeRepoPath(root, relativePath);
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
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
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
      `${label} valuesExport '${exportName}' must be an exported string array.`
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
        `${label} valuesExport '${exportName}' must contain only string literals.`
      );
      return null;
    }
    values.push(element.text);
  }
  return values;
}

function exportedStringValues(target, owner, exportName, label, errors) {
  const sourceFile = ts.createSourceFile(
    target,
    readFileSync(target, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const declaration = findExportedConst(sourceFile, exportName);
  if (!declaration?.initializer) {
    errors.push(
      `${label} valuesExport '${exportName}' was not found in ${owner}.`
    );
    return null;
  }
  return arrayLiteralStrings(
    declaration.initializer,
    exportName,
    label,
    errors
  );
}

export function requireMatchingValueExport(
  root,
  owner,
  exportName,
  values,
  label,
  errors
) {
  if (exportName === undefined) {
    return;
  }
  if (typeof exportName !== "string" || exportName.length === 0) {
    errors.push(`${label}.valuesExport must be a string.`);
    return;
  }
  const target = safeRepoPath(root, owner);
  if (!target || !existsSync(target)) {
    return;
  }
  const exported = exportedStringValues(
    target,
    owner,
    exportName,
    label,
    errors
  );
  if (!exported) {
    return;
  }
  if (
    values.length !== exported.length ||
    values.some((value, index) => value !== exported[index])
  ) {
    errors.push(
      `${label}.values must match exported ${exportName}: [${exported.join(", ")}]`
    );
  }
}
