import { getTypeServices } from "./type-services.js";
import { isTestFile } from "./test-files.js";

const programIndexCache = new WeakMap();

const IGNORED_SOURCE_FILE_RE =
  /(?:^|\/)(?:node_modules|dist|build|coverage|_generated)\/|\.d\.[cm]?ts$/u;

function isWorkspaceSourceFile(sourceFile) {
  if (!sourceFile || sourceFile.isDeclarationFile) return false;
  const fileName = (sourceFile.fileName ?? "").replaceAll("\\", "/");
  return fileName.length > 0 && !IGNORED_SOURCE_FILE_RE.test(fileName);
}

function addSetEntry(map, key, entry) {
  if (!key) return;
  let bucket = map.get(key);
  if (!bucket) {
    bucket = new Set();
    map.set(key, bucket);
  }
  bucket.add(entry);
}

function recordExportedSymbol(expSymbol, fileName, checker, index) {
  const name = expSymbol?.name;
  if (typeof name !== "string" || name.startsWith("__")) return;
  addSetEntry(index.declaredNames, name, fileName);
  const declaredType = checker.getDeclaredTypeOfSymbol(expSymbol);
  const valueType =
    (declaredType?.flags ?? 0) <= 1
      ? checker.getTypeOfSymbol?.(expSymbol)
      : declaredType;
  const targetType = valueType ?? declaredType;
  if (!targetType) return;
  const propertyNames = (checker.getPropertiesOfType(targetType) ?? [])
    .map((prop) => prop?.name)
    .filter(
      (propName) => typeof propName === "string" && !propName.startsWith("__")
    );
  if (propertyNames.length < 3 || propertyNames.length > 40) return;
  const fields = [...new Set(propertyNames)].sort();
  if (fields.length < 3) return;
  index.exportedOwners.push({
    name,
    fileName,
    fields,
    fieldSet: new Set(fields),
    fieldKey: fields.join(","),
  });
}

function nodeImplementationId(tsNode, fileName) {
  return `${fileName}:${tsNode.name?.text ?? tsNode.pos ?? 0}`;
}

function heritageTargetName(heritageType) {
  const expr = heritageType?.expression;
  return expr?.text ?? expr?.name?.text ?? null;
}

function recordHeritageAndAnnotations(tsNode, fileName, index) {
  const implId = nodeImplementationId(tsNode, fileName);
  if (Array.isArray(tsNode.heritageClauses)) {
    for (const clause of tsNode.heritageClauses) {
      for (const heritageType of clause.types ?? []) {
        addSetEntry(
          index.implementedSeams,
          heritageTargetName(heritageType),
          implId
        );
      }
    }
  }
  const typeName = tsNode.type?.typeName;
  const typeRefName = typeName?.text ?? typeName?.right?.text ?? null;
  if (typeRefName && Array.isArray(tsNode.initializer?.properties)) {
    addSetEntry(index.implementedSeams, typeRefName, implId);
  }
}

function recordCallNode(tsNode, inTestFile, index) {
  if (
    !tsNode.expression ||
    !Array.isArray(tsNode.arguments) ||
    tsNode.typeName
  ) {
    return;
  }
  const calleeName =
    tsNode.expression.text ?? tsNode.expression.name?.text ?? null;
  if (typeof calleeName !== "string" || calleeName.length === 0) return;
  const argCount = tsNode.arguments.length;
  let stats = index.callStats.get(calleeName);
  if (!stats) {
    stats = {
      totalCalls: 0,
      nonTestCalls: 0,
      maxArgsNonTest: 0,
      maxArgsTest: 0,
    };
    index.callStats.set(calleeName, stats);
  }
  stats.totalCalls += 1;
  if (inTestFile) {
    if (argCount > stats.maxArgsTest) stats.maxArgsTest = argCount;
  } else {
    stats.nonTestCalls += 1;
    if (argCount > stats.maxArgsNonTest) stats.maxArgsNonTest = argCount;
  }
}

function walkSourceFileNode(tsNode, fileName, inTestFile, index) {
  if (!tsNode || typeof tsNode !== "object") return;
  if (typeof tsNode.name?.text === "string" && tsNode.parent?.statements) {
    addSetEntry(index.declaredNames, tsNode.name.text, fileName);
  }
  recordHeritageAndAnnotations(tsNode, fileName, index);
  recordCallNode(tsNode, inTestFile, index);
  if (typeof tsNode.forEachChild === "function") {
    tsNode.forEachChild((child) =>
      walkSourceFileNode(child, fileName, inTestFile, index)
    );
  }
}

function buildProgramIndex(program, checker) {
  const index = {
    exportedOwners: [],
    declaredNames: new Map(),
    implementedSeams: new Map(),
    callStats: new Map(),
  };
  const sourceFiles = program.getSourceFiles?.() ?? [];
  for (const sourceFile of sourceFiles) {
    if (!isWorkspaceSourceFile(sourceFile)) continue;
    const fileName = sourceFile.fileName.replaceAll("\\", "/");
    const inTest = isTestFile(fileName);
    if (!inTest) {
      const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
      const moduleExports = moduleSymbol
        ? (checker.getExportsOfModule(moduleSymbol) ?? [])
        : [];
      for (const expSymbol of moduleExports) {
        recordExportedSymbol(expSymbol, fileName, checker, index);
      }
    }
    walkSourceFileNode(sourceFile, fileName, inTest, index);
  }
  return index;
}

export function getProgramIndex(sourceCode) {
  const services = getTypeServices(sourceCode);
  if (!services?.program) return null;
  let cached = programIndexCache.get(services.program);
  if (!cached) {
    cached = buildProgramIndex(services.program, services.checker);
    programIndexCache.set(services.program, cached);
  }
  return cached;
}
