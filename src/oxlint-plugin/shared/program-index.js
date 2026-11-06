import { existsSync } from "node:fs";

import { getTypeServices } from "./type-services.js";
import { isTestFile } from "./scope.js";
import {
  contentSignature,
  createEmptyFileSnapshot,
  resolveWorkspaceRoot,
  syncUnloadedWorkspacePackages,
} from "./workspace-package-scan.js";

const workspaceIndexCache = new Map();
const programFastCache = new WeakMap();

const DEFAULT_LIB_OR_NODE_TYPES_RE =
  /\/typescript\/lib\/lib\.[^/]+\.d\.ts$|\/node_modules\/@types\/node\//u;
const BUILD_OUTPUT_RE = /(?:^|\/)(?:dist|build|coverage)\//u;
const GENERATED_PATH_RE =
  /(?:^|\/)(?:_generated|__generated__|generated)\/|\.(?:gen|generated)\.[cm]?tsx?$/u;
const GENERATED_HEADER_RE = /@generated\b|DO NOT EDIT|auto-?generated/iu;

const ORIGIN_PRIORITY = {
  generated: 0,
  node_modules: 1,
  package: 2,
  workspace: 3,
};

export function classifyFileOriginPriority(fileName) {
  const normalized = (fileName ?? "").replaceAll("\\", "/");
  if (GENERATED_PATH_RE.test(normalized)) return ORIGIN_PRIORITY.generated;
  if (normalized.includes("/node_modules/")) {
    return ORIGIN_PRIORITY.node_modules;
  }
  if (normalized.includes("/packages/")) return ORIGIN_PRIORITY.package;
  return ORIGIN_PRIORITY.workspace;
}

function classifySourceFileOrigin(program, sourceFile) {
  if (!sourceFile || program.isSourceFileDefaultLibrary?.(sourceFile)) {
    return null;
  }
  const fileName = (sourceFile.fileName ?? "").replaceAll("\\", "/");
  if (!fileName || DEFAULT_LIB_OR_NODE_TYPES_RE.test(fileName)) return null;
  if (fileName.includes("/node_modules/")) {
    return "node_modules";
  }
  if (BUILD_OUTPUT_RE.test(fileName)) return null;
  if (
    GENERATED_PATH_RE.test(fileName) ||
    GENERATED_HEADER_RE.test((sourceFile.text ?? "").slice(0, 512))
  ) {
    return "generated";
  }
  if (fileName.includes("/packages/")) return "package";
  return "workspace";
}

function sortInlineObjectFields(rawText) {
  return rawText.replaceAll(/\{([^{}]+)\}/gu, (_match, body) => {
    const parts = body
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length < 2 || !parts.every((part) => part.includes(":"))) {
      return `{ ${parts.join("; ")} }`;
    }
    return `{ ${parts.toSorted().join("; ")} }`;
  });
}

function normalizeTypeText(rawText) {
  if (typeof rawText !== "string") return null;
  const trimmed = rawText.replaceAll(/\s+/gu, " ").trim();
  if (
    !trimmed ||
    trimmed === "any" ||
    trimmed === "unknown" ||
    trimmed === "never"
  ) {
    return null;
  }
  const normalizedObjects = sortInlineObjectFields(trimmed);
  if (!normalizedObjects.includes("|") || normalizedObjects.includes("{")) {
    return normalizedObjects;
  }
  const unionParts = normalizedObjects
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);
  return unionParts.length >= 2
    ? [...new Set(unionParts)].toSorted().join(" | ")
    : normalizedObjects;
}

export function canonicalPropTypeText(propType, checker) {
  if (!propType || !checker) return null;
  if (propType.isUnion?.() && Array.isArray(propType.types)) {
    const parts = propType.types
      .map((part) => checker.typeToString?.(part, undefined, 1))
      .filter(Boolean);
    if (parts.length > 0) {
      return normalizeTypeText([...new Set(parts)].toSorted().join(" | "));
    }
  }
  return normalizeTypeText(
    checker.typeToString?.(propType, undefined, 1) ?? null
  );
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

function addOwnerToBucketMap(bucketMap, key, owner) {
  let bucket = bucketMap.get(key);
  if (!bucket) {
    bucket = [];
    bucketMap.set(key, bucket);
  }
  bucket.push(owner);
}

const SCHEMA_OUTPUT_PROPS = ["_output", "Type", "static", "type"];

export function unwrapOwnedCarrierType(targetType, checker) {
  if (!targetType || !checker) return targetType;
  for (const propName of SCHEMA_OUTPUT_PROPS) {
    const sym = checker.getPropertyOfType(targetType, propName);
    const propType = sym && checker.getTypeOfSymbol?.(sym);
    if (propType && (propType.flags & 3) === 0) {
      return propType;
    }
  }
  const typesSym = checker.getPropertyOfType(targetType, "_types");
  const typesRecord = typesSym && checker.getTypeOfSymbol?.(typesSym);
  const outSym =
    typesRecord && checker.getPropertyOfType(typesRecord, "output");
  const outType = outSym && checker.getTypeOfSymbol?.(outSym);
  if (outType && (outType.flags & 3) === 0) return outType;
  return targetType;
}

function sortedUniqueUnionLiterals(literals) {
  const unique = [...new Set(literals)].toSorted();
  return unique.length >= 2 && unique.length === literals.length
    ? unique
    : null;
}

function unionConstituents(targetType, checker) {
  if (targetType?.isUnion?.()) return targetType.types ?? [];
  if (checker?.isTupleType?.(targetType)) {
    return checker.getTypeArguments?.(targetType) ?? [];
  }
  return [];
}

function extractStringUnionLiterals(targetType, checker) {
  const constituents = unionConstituents(targetType, checker);
  if (constituents.length < 2 || constituents.length > 50) return null;
  const literals = [];
  for (const part of constituents) {
    if (part?.intrinsicName === "undefined" || part?.intrinsicName === "null") {
      continue;
    }
    if (!part?.isStringLiteral?.() || typeof part.value !== "string") {
      return null;
    }
    literals.push(part.value);
  }
  return sortedUniqueUnionLiterals(literals);
}

function isLocalSchemaBinding(sourceFile, targetName) {
  if (typeof targetName !== "string") return false;
  for (const stmt of sourceFile?.statements ?? []) {
    for (const varDecl of stmt.declarationList?.declarations ?? []) {
      if (varDecl.name?.text !== targetName) continue;
      const init = varDecl.initializer;
      return Boolean(
        init && !(typeof init.text === "string" && !init.expression)
      );
    }
  }
  return false;
}

function isDerivedAliasDeclaration(decl) {
  if (!decl) return false;
  if (
    typeof decl.initializer?.text === "string" &&
    !decl.initializer.expression
  ) {
    return true;
  }
  const typeNode = decl.type;
  if (!typeNode?.typeName) return false;
  const refName =
    typeof typeNode.typeName.text === "string"
      ? typeNode.typeName.text
      : typeNode.typeName.right?.text;
  if (refName !== "infer" && refName !== "Infer" && refName !== "Static") {
    return true;
  }
  const targetName = typeNode.typeArguments?.[0]?.exprName?.text;
  return !isLocalSchemaBinding(decl.getSourceFile?.(), targetName);
}

function resolveExportTargetType(expSymbol, fileName, checker) {
  if ((expSymbol.flags & 2_097_152) !== 0) return null;
  const decl = expSymbol.declarations?.[0];
  const declFile = decl?.getSourceFile?.()?.fileName?.replaceAll("\\", "/");
  if ((declFile && declFile !== fileName) || isDerivedAliasDeclaration(decl)) {
    return null;
  }
  const declaredType = checker.getDeclaredTypeOfSymbol(expSymbol);
  if ((declaredType?.flags ?? 0) > 1) {
    return unwrapOwnedCarrierType(declaredType, checker);
  }
  const rawType = checker.getTypeOfSymbol?.(expSymbol);
  if (!rawType) return null;
  const unwrapped = unwrapOwnedCarrierType(rawType, checker);
  if (unwrapped !== rawType || checker.isTupleType?.(rawType)) {
    return unwrapped;
  }
  return null;
}

function extractPropTypesFromChecker(targetType, fields, checker) {
  const propTypes = new Map();
  for (const propName of fields) {
    const sym = checker.getPropertyOfType(targetType, propName);
    const propType = sym && checker.getTypeOfSymbol?.(sym);
    const text = canonicalPropTypeText(propType, checker);
    if (!text) return null;
    propTypes.set(propName, text);
  }
  return propTypes;
}

function recordExportedSymbol(expSymbol, fileName, origin, checker, snapshot) {
  const name = expSymbol?.name;
  if (typeof name !== "string" || name.startsWith("__")) return;
  if (origin === "package" || origin === "workspace") {
    snapshot.declaredNames.add(name);
  }
  const targetType = resolveExportTargetType(expSymbol, fileName, checker);
  if (!targetType) return;
  const unionLiterals = extractStringUnionLiterals(targetType, checker);
  if (unionLiterals) {
    snapshot.unionOwners.push({
      name,
      fileName,
      origin,
      priority: ORIGIN_PRIORITY[origin] ?? 2,
      literals: unionLiterals,
      unionKey: unionLiterals.join("|"),
    });
    return;
  }
  const propertyNames = (checker.getPropertiesOfType(targetType) ?? [])
    .map((prop) => prop?.name)
    .filter(
      (propName) => typeof propName === "string" && !propName.startsWith("__")
    );
  if (propertyNames.length < 2 || propertyNames.length > 40) return;
  const fields = [...new Set(propertyNames)].toSorted();
  const propTypes =
    fields.length >= 2
      ? extractPropTypesFromChecker(targetType, fields, checker)
      : null;
  if (!propTypes) return;
  snapshot.exportedOwners.push({
    name,
    fileName,
    origin,
    priority: ORIGIN_PRIORITY[origin] ?? 2,
    fields,
    fieldSet: new Set(fields),
    fieldKey: fields.join(","),
    propTypes,
  });
}

function extractAstMemberTypeText(member, sourceText) {
  const typeNode = member.type;
  if (typeof typeNode?.pos !== "number" || typeof typeNode?.end !== "number") {
    return null;
  }
  const rawSlice = sourceText
    .slice(typeNode.pos, typeNode.end)
    .replace(/^(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)+/u, "")
    .trim();
  if (!rawSlice) return null;
  const withOptional =
    member.questionToken && !/\bundefined\b/u.test(rawSlice)
      ? `${rawSlice} | undefined`
      : rawSlice;
  return normalizeTypeText(withOptional);
}

function isEligibleAstShapeStatement(statement, members) {
  if (
    typeof statement?.name?.text !== "string" ||
    statement.typeParameters?.length > 0 ||
    statement.heritageClauses?.length > 0
  ) {
    return false;
  }
  return (
    Array.isArray(members) &&
    members.length >= 2 &&
    members.length <= 40 &&
    !(statement.type?.members && statement.type.parameters)
  );
}

function isPropertySignatureMember(member) {
  const propName = member?.name?.text;
  return (
    typeof propName === "string" &&
    !propName.startsWith("__") &&
    Boolean(member.type) &&
    !Array.isArray(member.parameters)
  );
}

function extractAstStatementShape(statement, sourceText) {
  const members = statement.members ?? statement.type?.members;
  if (!isEligibleAstShapeStatement(statement, members)) {
    return null;
  }
  const propTypes = new Map();
  for (const member of members) {
    if (!isPropertySignatureMember(member)) return null;
    const propName = member.name.text;
    if (propTypes.has(propName)) return null;
    const typeText = extractAstMemberTypeText(member, sourceText);
    if (!typeText) return null;
    propTypes.set(propName, typeText);
  }
  const fields = [...propTypes.keys()].toSorted();
  return fields.length >= 2 ? { fields, propTypes } : null;
}

function extractAstTypeUnionLiterals(types) {
  if (!Array.isArray(types) || types.length < 2 || types.length > 50) {
    return null;
  }
  const literals = [];
  for (const part of types) {
    const text = part?.literal?.text;
    if (typeof text !== "string") return null;
    literals.push(text);
  }
  return sortedUniqueUnionLiterals(literals);
}

function extractAstUnionLiterals(statement) {
  if (
    typeof statement?.name?.text !== "string" ||
    statement.typeParameters?.length > 0
  ) {
    return null;
  }
  if (Array.isArray(statement.type?.types)) {
    return extractAstTypeUnionLiterals(statement.type.types);
  }
  if (
    Array.isArray(statement.members) &&
    !statement.type &&
    statement.members.length >= 2 &&
    statement.members.length <= 50 &&
    statement.members.every((member) => !member.type && member.name?.text)
  ) {
    const literals = statement.members.map(
      (member) => member.initializer?.text ?? member.name.text
    );
    return sortedUniqueUnionLiterals(literals);
  }
  return null;
}

function indexAstStatementOwners(sourceFile, origin, snapshot) {
  const fileName = sourceFile.fileName.replaceAll("\\", "/");
  const sourceText = sourceFile.text ?? "";
  for (const statement of sourceFile.statements ?? []) {
    const unionLiterals = extractAstUnionLiterals(statement);
    if (unionLiterals) {
      snapshot.unionOwners.push({
        name: statement.name.text,
        fileName,
        origin,
        priority: ORIGIN_PRIORITY[origin] ?? 2,
        literals: unionLiterals,
        unionKey: unionLiterals.join("|"),
      });
      continue;
    }
    const shape = extractAstStatementShape(statement, sourceText);
    if (!shape) continue;
    snapshot.exportedOwners.push({
      name: statement.name.text,
      fileName,
      origin,
      priority: ORIGIN_PRIORITY[origin] ?? 2,
      fields: shape.fields,
      fieldSet: new Set(shape.fields),
      fieldKey: shape.fields.join(","),
      propTypes: shape.propTypes,
    });
  }
}

export function resolveSymbolKey(checker, tsNode) {
  if (!checker || !tsNode) return null;
  let sym = checker.getSymbolAtLocation?.(tsNode);
  if (!sym) return null;
  if ((sym.flags & 2_097_152) !== 0 && checker.getAliasedSymbol) {
    const aliased = checker.getAliasedSymbol(sym);
    if (aliased && aliased.name !== "unknown") sym = aliased;
  }
  const decl = sym.declarations?.[0];
  const declFile = decl?.getSourceFile?.()?.fileName?.replaceAll("\\", "/");
  const ownerPrefix =
    typeof decl?.parent?.name?.text === "string"
      ? `${decl.parent.name.text}.`
      : "";
  return declFile && typeof sym.name === "string"
    ? `${declFile}:${ownerPrefix}${sym.name}`
    : null;
}

function heritageTargetName(heritageType) {
  const expr = heritageType?.expression;
  return typeof expr?.text === "string"
    ? expr.text
    : (expr?.name?.text ?? null);
}

function unwrappedTypeNameNode(typeNode) {
  if (!typeNode) return null;
  if (
    typeNode.typeName?.text === "Promise" &&
    Array.isArray(typeNode.typeArguments) &&
    typeNode.typeArguments.length === 1
  ) {
    return typeNode.typeArguments[0]?.typeName ?? null;
  }
  return typeNode.typeName ?? null;
}

function isSeamImplementationNode(tsNode) {
  if (Array.isArray(tsNode.initializer?.properties)) return true;
  return (
    !tsNode.parameters &&
    !tsNode.name &&
    Array.isArray(tsNode.expression?.properties)
  );
}

function recordHeritageAndAnnotations(tsNode, checker, snapshot) {
  if (isTestFile(snapshot.fileName)) return;
  const label =
    typeof tsNode.name?.text === "string"
      ? tsNode.name.text
      : String(tsNode.pos ?? 0);
  const implId = `${snapshot.fileName}:${label}`;
  if (Array.isArray(tsNode.heritageClauses)) {
    for (const clause of tsNode.heritageClauses) {
      for (const heritageType of clause.types ?? []) {
        addSetEntry(
          snapshot.implementedSeams,
          heritageTargetName(heritageType),
          implId
        );
        addSetEntry(
          snapshot.implementedSeams,
          resolveSymbolKey(checker, heritageType?.expression),
          implId
        );
      }
    }
  }
  const typeName = isSeamImplementationNode(tsNode)
    ? unwrappedTypeNameNode(tsNode.type)
    : null;
  const typeRefName =
    typeof typeName?.text === "string"
      ? typeName.text
      : (typeName?.right?.text ?? null);
  if (typeRefName) {
    addSetEntry(snapshot.implementedSeams, typeRefName, implId);
    addSetEntry(
      snapshot.implementedSeams,
      resolveSymbolKey(checker, typeName),
      implId
    );
  }
}

function bumpCallStats(callStats, key, argCount, inTestFile) {
  if (!key) return;
  let stats = callStats.get(key);
  if (!stats) {
    stats = {
      totalCalls: 0,
      nonTestCalls: 0,
      maxArgsNonTest: 0,
      maxArgsTest: 0,
    };
    callStats.set(key, stats);
  }
  stats.totalCalls += 1;
  if (inTestFile) {
    if (argCount > stats.maxArgsTest) stats.maxArgsTest = argCount;
  } else {
    stats.nonTestCalls += 1;
    if (argCount > stats.maxArgsNonTest) stats.maxArgsNonTest = argCount;
  }
}

function recordCallNode(tsNode, inTestFile, snapshot) {
  if (
    !tsNode.expression ||
    !Array.isArray(tsNode.arguments) ||
    tsNode.typeName
  ) {
    return null;
  }
  const directCalleeName =
    typeof tsNode.expression.text === "string" ? tsNode.expression.text : null;
  const memberCalleeName =
    typeof tsNode.expression.name?.text === "string"
      ? tsNode.expression.name.text
      : null;
  if (!directCalleeName && !memberCalleeName) return null;
  const argCount = tsNode.arguments.length;
  if (directCalleeName) {
    bumpCallStats(snapshot.callStats, directCalleeName, argCount, inTestFile);
  }
  return argCount;
}

function recordImportAndEffectSignals(sourceFile, snapshot) {
  for (const statement of sourceFile.statements ?? []) {
    const moduleSpec = statement.moduleSpecifier?.text;
    if (typeof moduleSpec !== "string") continue;
    if (moduleSpec === "effect" || moduleSpec.startsWith("@effect/")) {
      snapshot.isEffectModule = true;
    }
    const clause =
      statement.importClause?.namedBindings ?? statement.exportClause;
    for (const specifier of clause?.elements ?? []) {
      const importedName = specifier.propertyName?.text ?? specifier.name?.text;
      if (typeof importedName === "string") {
        snapshot.importCounts.set(
          importedName,
          (snapshot.importCounts.get(importedName) ?? 0) + 1
        );
      }
    }
  }
  if (
    /\b(?:Context\.Tag|Effect\.(?:Service|Tag)|Layer\.(?:succeed|effect|scoped|provide))\b/u.test(
      sourceFile.text ?? ""
    )
  ) {
    snapshot.isEffectModule = true;
  }
}

function walkSourceFileNode(tsNode, inTestFile, checker, snapshot) {
  if (!tsNode || typeof tsNode !== "object") return;
  if (typeof tsNode.name?.text === "string" && tsNode.parent?.statements) {
    snapshot.declaredNames.add(tsNode.name.text);
  }
  recordHeritageAndAnnotations(tsNode, checker, snapshot);
  const argCount = recordCallNode(tsNode, inTestFile, snapshot);
  if (argCount !== null) {
    bumpCallStats(
      snapshot.callStats,
      resolveSymbolKey(checker, tsNode.expression),
      argCount,
      inTestFile
    );
  }
  if (typeof tsNode.forEachChild === "function") {
    tsNode.forEachChild((child) =>
      walkSourceFileNode(child, inTestFile, checker, snapshot)
    );
  }
}

function buildSourceFileSnapshot(sourceFile, origin, checker) {
  const fileName = sourceFile.fileName.replaceAll("\\", "/");
  const snapshot = createEmptyFileSnapshot(fileName, origin, false);
  snapshot.signature = contentSignature(sourceFile.text ?? "");
  if (origin === "node_modules") {
    indexAstStatementOwners(sourceFile, origin, snapshot);
    return snapshot;
  }
  const inTest = isTestFile(fileName);
  if (!inTest) {
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
    const moduleExports = moduleSymbol
      ? (checker.getExportsOfModule(moduleSymbol) ?? [])
      : [];
    if (moduleExports.length > 0) {
      for (const expSymbol of moduleExports) {
        recordExportedSymbol(expSymbol, fileName, origin, checker, snapshot);
      }
    } else {
      indexAstStatementOwners(sourceFile, origin, snapshot);
    }
  }
  if (!sourceFile.isDeclarationFile && origin !== "generated") {
    recordImportAndEffectSignals(sourceFile, snapshot);
    walkSourceFileNode(sourceFile, inTest, checker, snapshot);
  }
  return snapshot;
}

function sortOwnerBuckets(bucketMap) {
  for (const bucket of bucketMap.values()) {
    bucket.sort(
      (left, right) =>
        left.priority - right.priority ||
        left.fileName.localeCompare(right.fileName)
    );
  }
}

function mergeCallStats(targetMap, sourceMap) {
  for (const [key, stats] of sourceMap) {
    let acc = targetMap.get(key);
    if (!acc) {
      acc = {
        totalCalls: 0,
        nonTestCalls: 0,
        maxArgsNonTest: 0,
        maxArgsTest: 0,
      };
      targetMap.set(key, acc);
    }
    acc.totalCalls += stats.totalCalls;
    acc.nonTestCalls += stats.nonTestCalls;
    if (stats.maxArgsNonTest > acc.maxArgsNonTest) {
      acc.maxArgsNonTest = stats.maxArgsNonTest;
    }
    if (stats.maxArgsTest > acc.maxArgsTest) {
      acc.maxArgsTest = stats.maxArgsTest;
    }
  }
}

function mergeFileSnapshots(fileSnapshots) {
  const index = {
    exportedOwners: [],
    ownersByFieldKey: new Map(),
    ownersByUnionKey: new Map(),
    declaredNames: new Map(),
    implementedSeams: new Map(),
    callStats: new Map(),
    importCounts: new Map(),
    effectModules: new Set(),
  };
  for (const snapshot of fileSnapshots.values()) {
    for (const owner of snapshot.exportedOwners) {
      index.exportedOwners.push(owner);
      addOwnerToBucketMap(index.ownersByFieldKey, owner.fieldKey, owner);
    }
    for (const unionOwner of snapshot.unionOwners) {
      addOwnerToBucketMap(
        index.ownersByUnionKey,
        unionOwner.unionKey,
        unionOwner
      );
    }
    for (const name of snapshot.declaredNames) {
      addSetEntry(index.declaredNames, name, snapshot.fileName);
    }
    for (const [seamKey, impls] of snapshot.implementedSeams) {
      for (const implId of impls) {
        addSetEntry(index.implementedSeams, seamKey, implId);
      }
    }
    mergeCallStats(index.callStats, snapshot.callStats);
    for (const [importedName, count] of snapshot.importCounts) {
      index.importCounts.set(
        importedName,
        (index.importCounts.get(importedName) ?? 0) + count
      );
    }
    if (snapshot.isEffectModule) {
      index.effectModules.add(snapshot.fileName);
    }
  }
  sortOwnerBuckets(index.ownersByFieldKey);
  sortOwnerBuckets(index.ownersByUnionKey);
  return index;
}

function getWorkspaceState(program) {
  const root = resolveWorkspaceRoot(program);
  let state = workspaceIndexCache.get(root);
  if (!state) {
    state = {
      root,
      version: 0,
      fileSnapshots: new Map(),
      packageFiles: null,
      mergedIndex: null,
    };
    workspaceIndexCache.set(root, state);
  }
  return state;
}

function syncProgramIntoWorkspace(program, checker, workspaceState) {
  let changed = syncUnloadedWorkspacePackages(
    workspaceState,
    ORIGIN_PRIORITY.package
  );
  const sourceFiles = program.getSourceFiles?.() ?? [];
  const activeSourceFiles = new Set();
  for (const sourceFile of sourceFiles) {
    const origin = classifySourceFileOrigin(program, sourceFile);
    if (!origin) continue;
    const fileName = sourceFile.fileName.replaceAll("\\", "/");
    activeSourceFiles.add(fileName);
    const signature = contentSignature(sourceFile.text ?? "");
    const existing = workspaceState.fileSnapshots.get(fileName);
    if (existing && existing.signature === signature && !existing.astOnly) {
      continue;
    }
    const snapshot = buildSourceFileSnapshot(sourceFile, origin, checker);
    workspaceState.fileSnapshots.set(fileName, snapshot);
    changed = true;
  }
  for (const [fileName, snapshot] of workspaceState.fileSnapshots) {
    if (
      !snapshot.astOnly &&
      !activeSourceFiles.has(fileName) &&
      !existsSync(fileName)
    ) {
      workspaceState.fileSnapshots.delete(fileName);
      changed = true;
    }
  }
  if (changed || !workspaceState.mergedIndex) {
    workspaceState.version += 1;
    workspaceState.mergedIndex = mergeFileSnapshots(
      workspaceState.fileSnapshots
    );
  }
  return workspaceState.mergedIndex;
}

export function getProgramIndex(sourceCode) {
  const services = getTypeServices(sourceCode);
  if (!services?.program) return null;
  const workspaceState = getWorkspaceState(services.program);
  const fast = programFastCache.get(services.program);
  if (fast && fast.version === workspaceState.version) {
    return fast.index;
  }
  const index = syncProgramIntoWorkspace(
    services.program,
    services.checker,
    workspaceState
  );
  programFastCache.set(services.program, {
    version: workspaceState.version,
    index,
  });
  return index;
}
