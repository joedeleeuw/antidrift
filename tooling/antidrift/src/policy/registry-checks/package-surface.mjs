import { isAbsolute, join, resolve, sep } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import ts from "typescript";
import { SEMANTIC_ADAPTER_CONTRACTS } from "../../semantic-adapters/index.mjs";

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function readPackageJson(repoRoot, errors) {
  const file = join(repoRoot, "tooling", "antidrift", "package.json");
  if (!existsSync(file)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) ?? {};
    if (!isRecord(parsed)) {
      errors.push("tooling/antidrift/package.json must contain a mapping.");
      return null;
    }
    return parsed;
  } catch (error) {
    errors.push(
      `tooling/antidrift/package.json could not be parsed: ${error.message}`,
    );
    return null;
  }
}
function safeRepoPath(repoRoot, relativePath) {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    return null;
  }
  const root = resolve(repoRoot);
  const target = resolve(root, relativePath);
  return target === root || target.startsWith(root + sep) ? target : null;
}
function sortedStrings(values) {
  return [...values].sort((a, b) => a.localeCompare(b));
}
function checkSemanticAdapterPackageExportEntry(
  exportsMap,
  exportKey,
  expectedTypes,
  expectedImport,
  errors,
) {
  const label = "tooling/antidrift/package.json exports";
  const exportLabel = `${label}${exportKey}`;
  const entry = exportsMap[exportKey];
  if (!isRecord(entry)) {
    errors.push(`${label} missing semantic adapter subpath: ${exportKey}`);
    return;
  }
  if (entry.types !== expectedTypes) {
    errors.push(`${exportLabel}.types must be ${expectedTypes}.`);
  }
  if (entry.import !== expectedImport) {
    errors.push(`${exportLabel}.import must be ${expectedImport}.`);
  }
}
function requireExistingPackageExportPath(
  repoRoot,
  packagePath,
  label,
  errors,
) {
  if (
    typeof packagePath !== "string" ||
    packagePath.length === 0 ||
    !packagePath.startsWith("./")
  ) {
    errors.push(`${label} must be a package-relative ./ path.`);
    return;
  }
  const target = safeRepoPath(
    repoRoot,
    join("tooling", "antidrift", packagePath.slice(2)),
  );
  if (!target) {
    errors.push(`${label} must stay inside tooling/antidrift.`);
    return;
  }
  if (!existsSync(target)) {
    errors.push(`${label} path does not exist: ${packagePath}`);
  }
}
function packageExportTarget(repoRoot, packagePath) {
  if (
    typeof packagePath !== "string" ||
    packagePath.length === 0 ||
    !packagePath.startsWith("./")
  ) {
    return null;
  }
  const target = safeRepoPath(
    repoRoot,
    join("tooling", "antidrift", packagePath.slice(2)),
  );
  return target && existsSync(target) ? target : null;
}
function hasExportModifier(node) {
  return ts
    .getModifiers(node)
    ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}
function hasDefaultModifier(node) {
  return ts
    .getModifiers(node)
    ?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
}
function addBindingNames(name, names) {
  if (ts.isIdentifier(name)) {
    names.add(name.text);
    return;
  }
  if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) {
        addBindingNames(element.name, names);
      }
    }
  }
}
function addNamedExportNames(statement, names) {
  if (
    !ts.isExportDeclaration(statement) ||
    statement.isTypeOnly ||
    !statement.exportClause ||
    !ts.isNamedExports(statement.exportClause)
  ) {
    return;
  }
  for (const element of statement.exportClause.elements) {
    if (!element.isTypeOnly) {
      names.add(element.name.text);
    }
  }
}
function addExportedDeclarationName(statement, names) {
  if (!hasExportModifier(statement)) {
    return;
  }
  if (hasDefaultModifier(statement)) {
    names.add("default");
    return;
  }
  if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      addBindingNames(declaration.name, names);
    }
    return;
  }
  if (
    (ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isEnumDeclaration(statement)) &&
    statement.name
  ) {
    names.add(statement.name.text);
  }
}
function packageExportedValueNames(sourceText, fileName, scriptKind) {
  const source = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    false,
    scriptKind,
  );
  const names = new Set();
  for (const statement of source.statements) {
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      names.add("default");
      continue;
    }
    addNamedExportNames(statement, names);
    addExportedDeclarationName(statement, names);
  }
  return names;
}
function checkPackageExportRuntimeDeclarations(
  exportLabel,
  typesPath,
  importPath,
  repoRoot,
  errors,
) {
  const runtimeTarget = packageExportTarget(repoRoot, importPath);
  const typeTarget = packageExportTarget(repoRoot, typesPath);
  if (!runtimeTarget || !typeTarget) {
    return;
  }
  const runtimeNames = packageExportedValueNames(
    readFileSync(runtimeTarget, "utf8"),
    importPath,
    ts.ScriptKind.JS,
  );
  const typeNames = packageExportedValueNames(
    readFileSync(typeTarget, "utf8"),
    typesPath,
    ts.ScriptKind.TS,
  );
  for (const name of sortedStrings(runtimeNames)) {
    if (!typeNames.has(name)) {
      errors.push(
        `${exportLabel}.import runtime export ${name} is missing from types path ${typesPath}`,
      );
    }
  }
  for (const name of sortedStrings(typeNames)) {
    if (!runtimeNames.has(name)) {
      errors.push(
        `${exportLabel}.types declaration ${name} is missing from runtime import path ${importPath}`,
      );
    }
  }
}
function checkPackageExportEntryFilesAndDeclarations(
  exportKey,
  entry,
  repoRoot,
  errors,
) {
  if (!isRecord(entry)) {
    return;
  }
  if (typeof entry.types !== "string" || typeof entry.import !== "string") {
    return;
  }
  const label = `tooling/antidrift/package.json exports${exportKey}`;
  requireExistingPackageExportPath(
    repoRoot,
    entry.types,
    `${label}.types`,
    errors,
  );
  requireExistingPackageExportPath(
    repoRoot,
    entry.import,
    `${label}.import`,
    errors,
  );
  checkPackageExportRuntimeDeclarations(
    label,
    entry.types,
    entry.import,
    repoRoot,
    errors,
  );
}
function checkPackageExportFilesAndDeclarations(packageJson, repoRoot, errors) {
  const exportsMap = packageJson.exports;
  if (!isRecord(exportsMap)) {
    return;
  }
  for (const exportKey of sortedStrings(Object.keys(exportsMap))) {
    checkPackageExportEntryFilesAndDeclarations(
      exportKey,
      exportsMap[exportKey],
      repoRoot,
      errors,
    );
  }
}
function packageRelativeTarget(repoRoot, packagePath, label, errors) {
  if (typeof packagePath !== "string" || packagePath.length === 0) {
    errors.push(`${label} must be a package-relative path.`);
    return null;
  }
  const relativePackagePath = packagePath.startsWith("./")
    ? packagePath.slice(2)
    : packagePath;
  if (
    isAbsolute(relativePackagePath) ||
    relativePackagePath === ".." ||
    relativePackagePath.startsWith("../") ||
    relativePackagePath.includes("/../")
  ) {
    errors.push(`${label} must stay inside tooling/antidrift.`);
    return null;
  }
  const target = safeRepoPath(
    repoRoot,
    join("tooling", "antidrift", relativePackagePath),
  );
  if (!target) {
    errors.push(`${label} must stay inside tooling/antidrift.`);
    return null;
  }
  return target;
}
function requireExistingPackageBinPath(repoRoot, packagePath, label, errors) {
  const target = packageRelativeTarget(repoRoot, packagePath, label, errors);
  if (!target) {
    return null;
  }
  if (!existsSync(target)) {
    errors.push(`${label} path does not exist: ${packagePath}`);
    return null;
  }
  return target;
}
function checkPackageBinTarget(binary, packagePath, repoRoot, errors) {
  const label = `tooling/antidrift/package.json bin.${binary}`;
  const target = requireExistingPackageBinPath(
    repoRoot,
    packagePath,
    label,
    errors,
  );
  if (!target) {
    return;
  }
  const firstLine = readFileSync(target, "utf8").split(/\r?\n/u, 1)[0];
  if (firstLine !== "#!/usr/bin/env node") {
    errors.push(`${label} must start with #!/usr/bin/env node.`);
  }
}
function checkPackageBinTargets(packageJson, repoRoot, errors) {
  if (packageJson.bin === undefined) {
    return;
  }
  if (typeof packageJson.bin === "string") {
    const binary =
      typeof packageJson.name === "string" && packageJson.name.length > 0
        ? packageJson.name
        : "default";
    checkPackageBinTarget(binary, packageJson.bin, repoRoot, errors);
    return;
  }
  if (!isRecord(packageJson.bin)) {
    errors.push(
      "tooling/antidrift/package.json bin must be a string or mapping.",
    );
    return;
  }
  for (const binary of sortedStrings(Object.keys(packageJson.bin))) {
    checkPackageBinTarget(binary, packageJson.bin[binary], repoRoot, errors);
  }
}
function packageExportPublicSpecifier(packageName, exportKey) {
  if (exportKey === ".") {
    return packageName;
  }
  if (exportKey.startsWith("./")) {
    return `${packageName}/${exportKey.slice(2)}`;
  }
  return null;
}
function checkPackageReadmePublicEntry(readme, specifier, errors) {
  if (!readme.includes(`\`${specifier}\``)) {
    errors.push(
      `tooling/antidrift/README.md public entry points missing package export: ${specifier}`,
    );
  }
}
function checkPackageReadmeBinaryEntry(readme, binary, errors) {
  if (!readme.includes(`\`${binary}\``)) {
    errors.push(
      `tooling/antidrift/README.md public entry points missing CLI binary: ${binary}`,
    );
  }
}
function readmeCodeSpans(readme) {
  return [...readme.matchAll(/`([^`\n]+)`/gu)].map((match) => match[1]);
}
function packageReadmeSpecifiers(readme, packageName) {
  return readmeCodeSpans(readme).filter(
    (span) => span === packageName || span.startsWith(`${packageName}/`),
  );
}
function checkPackageReadmeNoStalePublicEntries(
  readme,
  packageName,
  expectedSpecifiers,
  errors,
) {
  for (const specifier of packageReadmeSpecifiers(readme, packageName)) {
    if (!expectedSpecifiers.has(specifier)) {
      errors.push(
        `tooling/antidrift/README.md public entry points lists non-exported package specifier: ${specifier}`,
      );
    }
  }
}
function checkPackageReadmePublicEntryPoints(packageJson, repoRoot, errors) {
  if (typeof packageJson.name !== "string" || packageJson.name.length === 0) {
    return;
  }
  const target = safeRepoPath(repoRoot, "tooling/antidrift/README.md");
  if (!target || !existsSync(target)) {
    return;
  }
  const readme = readFileSync(target, "utf8");
  const exportsMap = packageJson.exports;
  const expectedSpecifiers = new Set();
  if (isRecord(exportsMap)) {
    for (const exportKey of sortedStrings(Object.keys(exportsMap))) {
      const specifier = packageExportPublicSpecifier(
        packageJson.name,
        exportKey,
      );
      if (specifier) {
        expectedSpecifiers.add(specifier);
        checkPackageReadmePublicEntry(readme, specifier, errors);
      }
    }
    checkPackageReadmeNoStalePublicEntries(
      readme,
      packageJson.name,
      expectedSpecifiers,
      errors,
    );
  }
  if (typeof packageJson.bin === "string") {
    checkPackageReadmeBinaryEntry(readme, packageJson.name, errors);
  } else if (isRecord(packageJson.bin)) {
    for (const binary of sortedStrings(Object.keys(packageJson.bin))) {
      checkPackageReadmeBinaryEntry(readme, binary, errors);
    }
  }
}
function checkSemanticAdapterPackageExports(contracts, repoRoot, errors) {
  const packageJson = readPackageJson(repoRoot, errors);
  if (!packageJson) {
    return;
  }
  const exportsMap = packageJson.exports;
  if (!isRecord(exportsMap)) {
    errors.push("tooling/antidrift/package.json exports must be a mapping.");
    return;
  }
  checkSemanticAdapterPackageExportEntry(
    exportsMap,
    "./semantic-adapters",
    "./src/semantic-adapters/index.d.mts",
    "./src/semantic-adapters/index.mjs",
    errors,
  );
  for (const contract of Object.values(contracts)) {
    if (!isRecord(contract) || typeof contract.id !== "string") {
      continue;
    }
    const exportKey = `./semantic-adapters/${contract.id}`;
    checkSemanticAdapterPackageExportEntry(
      exportsMap,
      exportKey,
      `./src/semantic-adapters/${contract.id}.d.mts`,
      `./src/semantic-adapters/${contract.id}.mjs`,
      errors,
    );
  }
  checkPackageExportFilesAndDeclarations(packageJson, repoRoot, errors);
  checkPackageBinTargets(packageJson, repoRoot, errors);
  checkPackageReadmePublicEntryPoints(packageJson, repoRoot, errors);
}
export function checkPackageSurface(repoRoot, errors) {
  checkSemanticAdapterPackageExports(
    SEMANTIC_ADAPTER_CONTRACTS,
    repoRoot,
    errors,
  );
}
