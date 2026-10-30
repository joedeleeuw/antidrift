import { isAbsolute, join, resolve, sep } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import ts from "typescript";

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readPackageJson(root, errors) {
  const file = join(root, "tooling", "antidrift", "package.json");
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
      `tooling/antidrift/package.json could not be parsed: ${error.message}`
    );
    return null;
  }
}

function safeRepoPath(root, relativePath) {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    return null;
  }
  const target = resolve(root, relativePath);
  return target === root || target.startsWith(root + sep) ? target : null;
}

function sortedStrings(values) {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function validatePackageExportPath(root, packagePath, label) {
  if (
    typeof packagePath !== "string" ||
    packagePath.length === 0 ||
    !packagePath.startsWith("./")
  ) {
    return {
      target: null,
      errors: [`${label} must be a package-relative ./ path.`],
    };
  }
  const target = safeRepoPath(
    root,
    join("tooling", "antidrift", packagePath.slice(2))
  );
  if (!target) {
    return {
      target: null,
      errors: [`${label} must stay inside tooling/antidrift.`],
    };
  }
  if (!existsSync(target)) {
    return {
      target: null,
      errors: [`${label} path does not exist: ${packagePath}`],
    };
  }
  return { target, errors: [] };
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
    scriptKind
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

function sourceScriptKind(packagePath) {
  return packagePath.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS;
}

function exportNameMismatches(label, entry, importTarget, typesTarget) {
  const runtimeNames = packageExportedValueNames(
    readFileSync(importTarget, "utf8"),
    entry.import,
    sourceScriptKind(entry.import)
  );
  const typeNames = packageExportedValueNames(
    readFileSync(typesTarget, "utf8"),
    entry.types,
    ts.ScriptKind.TS
  );
  const errors = [];
  for (const name of sortedStrings(runtimeNames)) {
    if (!typeNames.has(name)) {
      errors.push(
        `${label}.import runtime export ${name} is missing from types path ${entry.types}`
      );
    }
  }
  for (const name of sortedStrings(typeNames)) {
    if (!runtimeNames.has(name)) {
      errors.push(
        `${label}.types declaration ${name} is missing from runtime import path ${entry.import}`
      );
    }
  }
  return errors;
}

function validateExportEntry(root, exportKey, entry) {
  if (!isRecord(entry)) {
    return [];
  }
  if (typeof entry.types !== "string" || typeof entry.import !== "string") {
    return [];
  }
  const label = `tooling/antidrift/package.json exports${exportKey}`;
  const typesResult = validatePackageExportPath(
    root,
    entry.types,
    `${label}.types`
  );
  const importResult = validatePackageExportPath(
    root,
    entry.import,
    `${label}.import`
  );
  const errors = [...typesResult.errors, ...importResult.errors];
  if (!typesResult.target || !importResult.target) {
    return errors;
  }
  return [
    ...errors,
    ...exportNameMismatches(
      label,
      entry,
      importResult.target,
      typesResult.target
    ),
  ];
}

function validateBinTarget(root, binary, packagePath) {
  const label = `tooling/antidrift/package.json bin.${binary}`;
  if (typeof packagePath !== "string" || packagePath.length === 0) {
    return [`${label} must be a package-relative path.`];
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
    return [`${label} must stay inside tooling/antidrift.`];
  }
  const target = safeRepoPath(
    root,
    join("tooling", "antidrift", relativePackagePath)
  );
  if (!target) {
    return [`${label} must stay inside tooling/antidrift.`];
  }
  if (!existsSync(target)) {
    return [`${label} path does not exist: ${packagePath}`];
  }
  const firstLine = readFileSync(target, "utf8").split(/\r?\n/u, 1)[0];
  if (firstLine !== "#!/usr/bin/env node") {
    return [`${label} must start with #!/usr/bin/env node.`];
  }
  return [];
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

function readmeCodeSpans(readme) {
  return [...readme.matchAll(/`([^`\n]+)`/gu)].map((match) => match[1]);
}

function packageBinNames(packageJson) {
  if (typeof packageJson.bin === "string") {
    return [packageJson.name];
  }
  if (isRecord(packageJson.bin)) {
    return sortedStrings(Object.keys(packageJson.bin));
  }
  return [];
}

function readmeExportErrors(readme, packageName, exportsMap) {
  const expectedSpecifiers = new Set();
  const errors = [];
  for (const exportKey of sortedStrings(Object.keys(exportsMap))) {
    const specifier = packageExportPublicSpecifier(packageName, exportKey);
    if (specifier) {
      expectedSpecifiers.add(specifier);
      if (!readme.includes(`\`${specifier}\``)) {
        errors.push(
          `tooling/antidrift/README.md public entry points missing package export: ${specifier}`
        );
      }
    }
  }
  const foundSpecifiers = readmeCodeSpans(readme).filter(
    (span) => span === packageName || span.startsWith(`${packageName}/`)
  );
  for (const specifier of foundSpecifiers) {
    if (!expectedSpecifiers.has(specifier)) {
      errors.push(
        `tooling/antidrift/README.md public entry points lists non-exported package specifier: ${specifier}`
      );
    }
  }
  return errors;
}

function validateReadmeEntries(root, packageJson) {
  if (typeof packageJson.name !== "string" || packageJson.name.length === 0) {
    return [];
  }
  const target = safeRepoPath(root, "tooling/antidrift/README.md");
  if (!target || !existsSync(target)) {
    return [];
  }
  const readme = readFileSync(target, "utf8");
  const exportsMap = packageJson.exports;
  const errors = isRecord(exportsMap)
    ? readmeExportErrors(readme, packageJson.name, exportsMap)
    : [];
  for (const binary of packageBinNames(packageJson)) {
    if (!readme.includes(`\`${binary}\``)) {
      errors.push(
        `tooling/antidrift/README.md public entry points missing CLI binary: ${binary}`
      );
    }
  }
  return errors;
}

export function checkPackageSurface(repoRoot, errors) {
  const root = resolve(repoRoot);
  const packageJson = readPackageJson(root, errors);
  if (!packageJson) {
    return;
  }
  const exportsMap = packageJson.exports;
  if (!isRecord(exportsMap)) {
    errors.push("tooling/antidrift/package.json exports must be a mapping.");
    return;
  }
  for (const exportKey of sortedStrings(Object.keys(exportsMap))) {
    errors.push(...validateExportEntry(root, exportKey, exportsMap[exportKey]));
  }
  if (typeof packageJson.bin === "string") {
    const binary =
      typeof packageJson.name === "string" && packageJson.name.length > 0
        ? packageJson.name
        : "default";
    errors.push(...validateBinTarget(root, binary, packageJson.bin));
  } else if (packageJson.bin !== undefined) {
    if (!isRecord(packageJson.bin)) {
      errors.push(
        "tooling/antidrift/package.json bin must be a string or mapping."
      );
    } else {
      for (const binary of sortedStrings(Object.keys(packageJson.bin))) {
        errors.push(
          ...validateBinTarget(root, binary, packageJson.bin[binary])
        );
      }
    }
  }
  errors.push(...validateReadmeEntries(root, packageJson));
}
