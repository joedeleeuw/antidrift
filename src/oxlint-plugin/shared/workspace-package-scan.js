import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { isTestFile } from "./scope.js";
import { getTypeScript } from "./type-services.js";

export function contentSignature(text) {
  let hash = 2_166_136_261;
  for (let idx = 0; idx < text.length; idx += 1) {
    hash ^= text.charCodeAt(idx);
    hash = Math.imul(hash, 16_777_619);
  }
  return `${text.length}:${hash >>> 0}`;
}

export function createEmptyFileSnapshot(fileName, origin, astOnly) {
  return {
    fileName,
    origin,
    signature: "",
    astOnly,
    exportedOwners: [],
    unionOwners: [],
    declaredNames: new Set(),
    implementedSeams: new Map(),
    callStats: new Map(),
    importCounts: new Map(),
    isEffectModule: false,
  };
}

function isExported(ts, node) {
  const modifiers = ts.canHaveModifiers?.(node)
    ? ts.getModifiers?.(node)
    : node.modifiers;
  return Boolean(
    modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
  );
}

function extractStringLiteralsFromArray(ts, arrayExpression) {
  if (!ts.isArrayLiteralExpression(arrayExpression)) return null;
  const literals = [];
  for (const element of arrayExpression.elements) {
    if (!ts.isStringLiteral(element)) return null;
    literals.push(element.text);
  }
  const unique = [...new Set(literals)].toSorted();
  return unique.length >= 2 && unique.length === literals.length
    ? unique
    : null;
}

function extractStringLiteralsFromUnion(ts, typeNode) {
  let unwrapped = typeNode;
  while (ts.isParenthesizedTypeNode(unwrapped)) {
    unwrapped = unwrapped.type;
  }
  if (!ts.isUnionTypeNode(unwrapped)) return null;
  const literals = [];
  for (const constituentNode of unwrapped.types) {
    let constituent = constituentNode;
    while (ts.isParenthesizedTypeNode(constituent)) {
      constituent = constituent.type;
    }
    if (
      !ts.isLiteralTypeNode(constituent) ||
      !ts.isStringLiteral(constituent.literal)
    ) {
      return null;
    }
    literals.push(constituent.literal.text);
  }
  const unique = [...new Set(literals)].toSorted();
  return unique.length >= 2 && unique.length === literals.length
    ? unique
    : null;
}

function addSeamImplementation(implementedSeams, seamName, location) {
  let bucket = implementedSeams.get(seamName);
  if (!bucket) {
    bucket = new Set();
    implementedSeams.set(seamName, bucket);
  }
  bucket.add(location);
}

function extractArrayLiteralsFromInit(ts, init) {
  if (ts.isAsExpression(init)) {
    const isConst =
      ts.isTypeReferenceNode(init.type) &&
      ts.isIdentifier(init.type.typeName) &&
      init.type.typeName.text === "const";
    return isConst ? extractStringLiteralsFromArray(ts, init.expression) : null;
  }
  if (ts.isCallExpression(init)) {
    let callee = init.expression;
    while (callee && ts.isParenthesizedExpression(callee)) {
      callee = callee.expression;
    }
    if (
      ts.isPropertyAccessExpression(callee) &&
      (callee.name.text === "enum" || callee.name.text === "picklist") &&
      init.arguments.length > 0
    ) {
      return extractStringLiteralsFromArray(ts, init.arguments[0]);
    }
  }
  return null;
}

function typeRefNameText(ts, typeNode) {
  if (!typeNode || !ts.isTypeReferenceNode(typeNode)) return null;
  const name = typeNode.typeName;
  if (ts.isIdentifier(name)) return name.text;
  if (name?.right && ts.isIdentifier(name.right)) return name.right.text;
  return null;
}

function indexVariableSeam(decl, init, context) {
  const { ts, fileName, sourceFile, snapshot } = context;
  const seamFromType =
    decl.type && init && ts.isObjectLiteralExpression(init)
      ? typeRefNameText(ts, decl.type)
      : null;
  if (seamFromType) {
    addSeamImplementation(
      snapshot.implementedSeams,
      seamFromType,
      `${fileName}:${decl.getStart(sourceFile)}`
    );
    return;
  }
  if (init && ts.isSatisfiesExpression(init)) {
    const seamFromSatisfies = ts.isObjectLiteralExpression(init.expression)
      ? typeRefNameText(ts, init.type)
      : null;
    if (seamFromSatisfies) {
      addSeamImplementation(
        snapshot.implementedSeams,
        seamFromSatisfies,
        `${fileName}:${decl.getStart(sourceFile)}`
      );
    }
  }
}

function recordVariableDeclaredNames(ts, nameNode, snapshot) {
  if (ts.isIdentifier(nameNode)) {
    snapshot.declaredNames.add(nameNode.text);
    return;
  }
  if (ts.isObjectBindingPattern(nameNode)) {
    for (const element of nameNode.elements) {
      if (ts.isIdentifier(element.name)) {
        snapshot.declaredNames.add(element.name.text);
      }
    }
  }
}

function indexVariableDeclaration(decl, exported, context) {
  if (!decl.name) return;
  const { ts, fileName, packagePriority, snapshot } = context;
  let init = decl.initializer;
  while (init && ts.isParenthesizedExpression(init)) {
    init = init.expression;
  }
  if (exported) {
    recordVariableDeclaredNames(ts, decl.name, snapshot);
    const name = ts.isIdentifier(decl.name) ? decl.name.text : null;
    if (name && init) {
      const literals = extractArrayLiteralsFromInit(ts, init);
      if (literals) {
        snapshot.unionOwners.push({
          name,
          fileName,
          origin: "package",
          priority: packagePriority,
          literals,
          unionKey: literals.join("|"),
        });
      }
    }
  }
  indexVariableSeam(decl, init, context);
}

function indexClassDeclaration(statement, exported, context) {
  const { ts, fileName, sourceFile, snapshot } = context;
  if (exported && statement.name && ts.isIdentifier(statement.name)) {
    snapshot.declaredNames.add(statement.name.text);
  }
  for (const clause of statement.heritageClauses ?? []) {
    if (clause.token !== ts.SyntaxKind.ImplementsKeyword) continue;
    for (const heritageType of clause.types ?? []) {
      const expr = heritageType.expression;
      let seamName = null;
      if (ts.isIdentifier(expr)) {
        seamName = expr.text;
      } else if (ts.isPropertyAccessExpression(expr)) {
        seamName = expr.name.text;
      }
      if (seamName) {
        addSeamImplementation(
          snapshot.implementedSeams,
          seamName,
          `${fileName}:${statement.getStart(sourceFile)}`
        );
      }
    }
  }
}

function indexTypeAliasDeclaration(statement, context) {
  const { ts, fileName, packagePriority, snapshot } = context;
  const name = statement.name?.text;
  if (!name) return;
  snapshot.declaredNames.add(name);
  const literals = extractStringLiteralsFromUnion(ts, statement.type);
  if (literals) {
    snapshot.unionOwners.push({
      name,
      fileName,
      origin: "package",
      priority: packagePriority,
      literals,
      unionKey: literals.join("|"),
    });
  }
}

function indexStatement(statement, context) {
  const { ts, snapshot } = context;
  if (ts.isExportDeclaration(statement)) {
    for (const element of statement.exportClause?.elements ?? []) {
      if (element.name?.text) {
        snapshot.declaredNames.add(element.name.text);
      }
    }
    return;
  }

  const exported = isExported(ts, statement);

  if (ts.isVariableStatement(statement)) {
    for (const decl of statement.declarationList?.declarations ?? []) {
      indexVariableDeclaration(decl, exported, context);
    }
    return;
  }

  if (ts.isClassDeclaration(statement)) {
    indexClassDeclaration(statement, exported, context);
    return;
  }

  if (!exported) return;

  if (ts.isTypeAliasDeclaration(statement)) {
    indexTypeAliasDeclaration(statement, context);
    return;
  }

  if (
    ts.isFunctionDeclaration(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    ts.isEnumDeclaration(statement)
  ) {
    if (statement.name && ts.isIdentifier(statement.name)) {
      snapshot.declaredNames.add(statement.name.text);
    }
  }
}

export function buildUnloadedPackageSnapshot(fileName, text, packagePriority) {
  const snapshot = createEmptyFileSnapshot(fileName, "package", true);
  snapshot.signature = contentSignature(text);
  const ts = getTypeScript();
  if (!ts) return snapshot;

  const sourceFile = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true
  );

  const context = {
    ts,
    fileName,
    packagePriority,
    sourceFile,
    snapshot,
  };

  for (const statement of sourceFile.statements ?? []) {
    indexStatement(statement, context);
  }

  return snapshot;
}

function collectPackageTsFiles(dirPath, depth, collectedFiles) {
  if (depth > 5 || !existsSync(dirPath)) return;
  let entries = [];
  try {
    entries = readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (
      entry.name.startsWith(".") ||
      entry.name === "node_modules" ||
      entry.name === "dist" ||
      entry.name === "build" ||
      entry.name === "coverage"
    ) {
      continue;
    }
    const fullPath = join(dirPath, entry.name).replaceAll("\\", "/");
    if (entry.isDirectory()) {
      collectPackageTsFiles(fullPath, depth + 1, collectedFiles);
    } else if (
      entry.isFile() &&
      /\.[cm]?tsx?$/u.test(entry.name) &&
      !entry.name.endsWith(".d.ts") &&
      !isTestFile(fullPath)
    ) {
      collectedFiles.push(fullPath);
    }
  }
}

export function syncUnloadedWorkspacePackages(workspaceState, packagePriority) {
  if (!workspaceState.packageFiles) {
    workspaceState.packageFiles = [];
    for (const subdir of ["packages", "apps"]) {
      const dir = join(workspaceState.root, subdir);
      if (existsSync(dir)) {
        collectPackageTsFiles(dir, 0, workspaceState.packageFiles);
      }
    }
  }
  if (workspaceState.packageFiles.length === 0) return false;
  let changed = false;
  for (const fileName of workspaceState.packageFiles) {
    const existing = workspaceState.fileSnapshots.get(fileName);
    if (existing && !existing.astOnly) continue;
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(fileName).mtimeMs;
    } catch {
      if (existing) {
        workspaceState.fileSnapshots.delete(fileName);
        changed = true;
      }
      continue;
    }
    if (existing && existing.mtimeMs === mtimeMs) continue;
    try {
      const text = readFileSync(fileName, "utf8");
      const snapshot = buildUnloadedPackageSnapshot(
        fileName,
        text,
        packagePriority
      );
      snapshot.mtimeMs = mtimeMs;
      workspaceState.fileSnapshots.set(fileName, snapshot);
      changed = true;
    } catch {
      continue;
    }
  }
  return changed;
}

export function resolveWorkspaceRoot(program) {
  const startDir = (
    program.getCurrentDirectory?.() ?? process.cwd()
  ).replaceAll("\\", "/");
  let cur = startDir;
  let candidate = startDir;
  for (let depth = 0; depth < 5; depth += 1) {
    if (
      existsSync(join(cur, "pnpm-workspace.yaml")) ||
      existsSync(join(cur, ".git")) ||
      existsSync(join(cur, "packages"))
    ) {
      return cur;
    }
    if (existsSync(join(cur, "package.json"))) {
      candidate = cur;
    }
    const parent = dirname(cur).replaceAll("\\", "/");
    if (parent === cur) break;
    cur = parent;
  }
  return candidate;
}
