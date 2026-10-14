import { posix } from "node:path";

import ts from "typescript";

const languageServices = new WeakMap();
const diagnosticBaselines = new WeakMap();

const TYPE_FORMAT =
  ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseFullyQualifiedType;
const PRIMITIVE_TYPES =
  ts.TypeFlags.StringLike |
  ts.TypeFlags.NumberLike |
  ts.TypeFlags.BooleanLike |
  ts.TypeFlags.BigIntLike |
  ts.TypeFlags.EnumLike |
  ts.TypeFlags.Null |
  ts.TypeFlags.Undefined;
const NULLISH_OR_UNKNOWN =
  ts.TypeFlags.Null |
  ts.TypeFlags.Undefined |
  ts.TypeFlags.Any |
  ts.TypeFlags.Unknown;
const LITERAL_KINDS = new Set([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NumericLiteral,
  ts.SyntaxKind.BigIntLiteral,
  ts.SyntaxKind.RegularExpressionLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateExpression,
  ts.SyntaxKind.TrueKeyword,
  ts.SyntaxKind.FalseKeyword,
  ts.SyntaxKind.NullKeyword,
]);

export function locationOf(node) {
  const sourceFile = node.getSourceFile();
  const { line } = sourceFile.getLineAndCharacterOfPosition(
    node.getStart(sourceFile)
  );
  return `${sourceFile.fileName}:${line + 1}`;
}

function parsedSourceFile(program, fileName) {
  const sourceFile = program.getSourceFile(fileName);
  return sourceFile?.redirectInfo?.unredirected ?? sourceFile;
}

function reusingDocumentRegistry(program) {
  const registry = ts.createDocumentRegistry();
  const reuse =
    (acquire) =>
    (fileName, ...rest) =>
      parsedSourceFile(program, fileName) ?? acquire(fileName, ...rest);
  return {
    ...registry,
    acquireDocument: reuse(registry.acquireDocument),
    acquireDocumentWithKey: reuse(registry.acquireDocumentWithKey),
    updateDocument: reuse(registry.updateDocument),
    updateDocumentWithKey: reuse(registry.updateDocumentWithKey),
    releaseDocument() {},
    releaseDocumentWithKey() {},
  };
}

function languageServiceOf(program) {
  const existing = languageServices.get(program);
  if (existing) return existing;
  const host = {
    getScriptFileNames: () => program.getRootFileNames(),
    getProjectVersion: () => "0",
    getScriptVersion: () => "0",
    getScriptSnapshot(fileName) {
      const text =
        program.getSourceFile(fileName)?.text ?? ts.sys.readFile(fileName);
      return text === undefined
        ? undefined
        : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => program.getCurrentDirectory(),
    getCompilationSettings: () => program.getCompilerOptions(),
    getProjectReferences: () => program.getProjectReferences(),
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
    realpath: ts.sys.realpath,
  };
  const service = ts.createLanguageService(
    host,
    reusingDocumentRegistry(program)
  );
  languageServices.set(program, service);
  return service;
}

function childContaining(node, position) {
  return ts.forEachChild(node, (child) =>
    child.pos <= position && position < child.end ? child : undefined
  );
}

function referenceAt(sourceFile, position) {
  let node = sourceFile;
  while (node) {
    if (
      (ts.isIdentifier(node) || ts.isStringLiteral(node)) &&
      node.getStart(sourceFile) === position
    ) {
      return { identifier: node };
    }
    if (node !== sourceFile && position < node.getStart(sourceFile)) {
      return { comment: true };
    }
    node = childContaining(node, position);
  }
  return {};
}

function expressionSpanning(sourceFile, start, end) {
  let node = sourceFile;
  while (node) {
    if (node.getStart(sourceFile) === start && node.end === end) return node;
    node = childContaining(node, start);
  }
  return undefined;
}

function classifyReference(identifier, nameNode) {
  if (identifier === nameNode) return { kind: "declaration" };
  const parent = identifier.parent;
  if (ts.isImportSpecifier(parent)) return { kind: "import", node: parent };
  if (ts.isExportSpecifier(parent)) {
    return parent.name.text === "default"
      ? { kind: "identity", node: parent, use: "default export" }
      : { kind: "export", node: parent };
  }
  const callee =
    ts.isPropertyAccessExpression(parent) && parent.name === identifier
      ? parent
      : identifier;
  const call = callee.parent;
  if (ts.isCallExpression(call) && call.expression === callee) {
    return { kind: "call", node: call };
  }
  const argument =
    (ts.isCallExpression(call) || ts.isNewExpression(call)) &&
    call.arguments?.includes(callee);
  return {
    kind: "identity",
    node: identifier,
    use: argument ? "call argument" : ts.SyntaxKind[call.kind],
  };
}

export function programReferences(program, nameNode) {
  const sourceFile = nameNode.getSourceFile();
  const referenced = languageServiceOf(program).findReferences(
    sourceFile.fileName,
    nameNode.getStart(sourceFile)
  );
  const found = { call: [], import: [], export: [], identity: [] };
  const seen = new Set();
  for (const entry of (referenced ?? []).flatMap(
    ({ references }) => references
  )) {
    const file = program.getSourceFile(entry.fileName);
    const { identifier, comment } = file
      ? referenceAt(file, entry.textSpan.start)
      : {};
    if (comment) continue;
    if (!identifier) {
      found.identity.push({ node: nameNode, use: "unmapped reference" });
      continue;
    }
    const reference = classifyReference(identifier, nameNode);
    if (reference.kind === "declaration" || seen.has(reference.node)) continue;
    seen.add(reference.node);
    found[reference.kind].push(reference);
  }
  return found;
}

export function declaredContract(program, declaration, nameNode) {
  const flags = ts.getCombinedModifierFlags(declaration);
  if (flags & ts.ModifierFlags.Default) return "default export";
  if (flags & ts.ModifierFlags.Ambient) return "ambient declaration";
  const symbol = program.getTypeChecker().getSymbolAtLocation(nameNode);
  if ((symbol?.declarations?.length ?? 0) > 1) {
    return "merged or overloaded declaration";
  }
  return null;
}

function targetOf(checker, symbol) {
  const target =
    symbol.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(symbol)
      : symbol;
  return checker.getExportSymbolOfSymbol(target);
}

export function exportTarget(program, nameNode) {
  const checker = program.getTypeChecker();
  return targetOf(checker, checker.getSymbolAtLocation(nameNode));
}

export function moduleExportTargets(program, sourceFiles) {
  const checker = program.getTypeChecker();
  const targets = new Set();
  for (const sourceFile of sourceFiles) {
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
    for (const exported of moduleSymbol
      ? checker.getExportsOfModule(moduleSymbol)
      : []) {
      targets.add(targetOf(checker, exported));
    }
  }
  return targets;
}

function commonDirectory(fileNames) {
  let shared = null;
  for (const fileName of fileNames) {
    if (/\.d\.[cm]?ts$/u.test(fileName)) continue;
    const parts = posix.dirname(fileName).split("/");
    shared ??= parts;
    const differs = shared.findIndex(
      (segment, index) => segment !== parts[index]
    );
    if (differs >= 0) shared = shared.slice(0, differs);
  }
  return shared?.join("/");
}

function rootDirectoryVariants(commandLine) {
  const variants = [commandLine];
  const computed = commonDirectory(commandLine.fileNames);
  if (!commandLine.options.rootDir && computed) {
    variants.push({
      ...commandLine,
      options: { ...commandLine.options, rootDir: computed },
    });
  }
  return variants;
}

function compilerCommandLines(configFiles) {
  const commandLines = [];
  for (const configFile of configFiles) {
    const loaded = ts.readConfigFile(configFile, ts.sys.readFile);
    if (loaded.error) continue;
    commandLines.push(
      ts.parseJsonConfigFileContent(
        loaded.config,
        ts.sys,
        posix.dirname(configFile),
        undefined,
        configFile
      )
    );
  }
  return commandLines.flatMap(rootDirectoryVariants).map((commandLine) => ({
    commandLine,
    contains: new Set(commandLine.fileNames),
  }));
}

function isTransparentWrapper(node) {
  return (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isTypeAssertionExpression(node)
  );
}

export function unwrapped(node) {
  let current = node;
  while (isTransparentWrapper(current)) current = current.expression;
  return current;
}

export function outermostWrapper(node) {
  let current = node;
  while (
    current.parent &&
    isTransparentWrapper(current.parent) &&
    current.parent.expression === current
  ) {
    current = current.parent;
  }
  return current;
}

export function packageSources(program, directory) {
  return program
    .getSourceFiles()
    .filter(
      (sourceFile) =>
        !sourceFile.isDeclarationFile &&
        sourceFile.fileName.startsWith(`${directory}/`)
    );
}

export function compilerOutputs(sources, configFiles) {
  const commandLines = compilerCommandLines(configFiles);
  return sources.flatMap((sourceFile) =>
    commandLines
      .filter(({ contains }) => contains.has(sourceFile.fileName))
      .flatMap(({ commandLine }) =>
        ts.getOutputFileNames(
          commandLine,
          sourceFile.fileName,
          !ts.sys.useCaseSensitiveFileNames
        )
      )
      .map((name) => ({ name, sourceFile }))
  );
}

function consistsOfLiterals(node) {
  if (LITERAL_KINDS.has(node.kind)) return true;
  if (
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isParenthesizedExpression(node)
  ) {
    return consistsOfLiterals(node.expression);
  }
  if (ts.isPrefixUnaryExpression(node)) return consistsOfLiterals(node.operand);
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.every(consistsOfLiterals);
  }
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.every(
      (property) =>
        ts.isPropertyAssignment(property) &&
        consistsOfLiterals(property.initializer)
    );
  }
  return false;
}

function isLiteralConstant(symbol) {
  const declaration = symbol?.valueDeclaration;
  if (symbol?.flags & ts.SymbolFlags.EnumMember) return true;
  return Boolean(
    declaration &&
    ts.isVariableDeclaration(declaration) &&
    ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const &&
    declaration.initializer &&
    consistsOfLiterals(declaration.initializer)
  );
}

function moduleLevel(declaration, sourceFile) {
  let statement = declaration;
  if (ts.isVariableDeclaration(statement)) statement = statement.parent.parent;
  return statement.parent === sourceFile ? statement : null;
}

function originOf(symbol, sourceFile) {
  const declaration = symbol.declarations?.[0];
  if (
    !declaration ||
    declaration.getSourceFile() !== sourceFile ||
    !ts.isExternalModule(sourceFile)
  ) {
    return { kind: "global" };
  }
  if (symbol.flags & ts.SymbolFlags.Alias) {
    return { kind: "import", declaration };
  }
  const statement = moduleLevel(declaration, sourceFile);
  return statement
    ? { kind: "module", declaration, statement }
    : { kind: "local", declaration };
}

export function bodyBindings(program, functionNode, call) {
  const checker = program.getTypeChecker();
  const sourceFile = call.getSourceFile();
  const parameterSymbols = functionNode.parameters.map((parameter) =>
    checker.getSymbolAtLocation(parameter.name)
  );
  const bindings = { uses: [], free: [], boundLiterals: 0, hazards: [] };
  function record(identifier, symbol, shorthand) {
    const index = parameterSymbols.indexOf(symbol);
    if (index >= 0) {
      bindings.uses.push({ node: identifier, index, shorthand });
    } else if (!symbol) {
      bindings.hazards.push(`unresolved name ${identifier.text}`);
    } else if (identifier.text === "arguments" && !symbol.declarations) {
      bindings.hazards.push("reads the arguments object");
    } else {
      const origin = originOf(symbol, sourceFile);
      bindings.free.push({ node: identifier, symbol, shorthand, origin });
      if (isLiteralConstant(targetOf(checker, symbol))) {
        bindings.boundLiterals++;
      }
    }
  }
  function visit(node) {
    if (LITERAL_KINDS.has(node.kind)) bindings.boundLiterals++;
    if (ts.isIdentifier(node)) {
      record(node, checker.getSymbolAtLocation(node), false);
    } else if (ts.isShorthandPropertyAssignment(node)) {
      record(node.name, checker.getShorthandAssignmentValueSymbol(node), true);
    } else if (ts.isPropertyAccessExpression(node)) {
      visit(node.expression);
    } else if (ts.isPropertyAssignment(node)) {
      if (ts.isComputedPropertyName(node.name)) visit(node.name);
      visit(node.initializer);
    } else {
      ts.forEachChild(node, visit);
    }
  }
  visit(call);
  return bindings;
}

export function bindingAtSite(program, free, site) {
  const checker = program.getTypeChecker();
  const visible = checker.resolveName(
    free.node.text,
    site,
    ts.SymbolFlags.Value,
    false
  );
  if (!visible) return "absent";
  return targetOf(checker, visible) === targetOf(checker, free.symbol)
    ? "same"
    : "other";
}

export function importOfFile(program, siteFile, targetFile) {
  const checker = program.getTypeChecker();
  return siteFile.statements.find(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      checker.getSymbolAtLocation(statement.moduleSpecifier)
        ?.valueDeclaration === targetFile
  );
}

function originalPosition(edited, position) {
  let delta = 0;
  for (const edit of edited?.edits ?? []) {
    const newEnd = edit.newStart + edit.text.length;
    if (position < edit.newStart) break;
    if (position < newEnd) return null;
    delta = newEnd - edit.end;
  }
  return position - delta;
}

function bindingKey(checker, symbol, editedFiles) {
  if (!symbol) return "unresolved";
  const target = targetOf(checker, symbol);
  const declaration = target.valueDeclaration ?? target.declarations?.[0];
  if (!declaration) return `global ${target.escapedName}`;
  const sourceFile = declaration.getSourceFile();
  const name = ts.getNameOfDeclaration(declaration) ?? declaration;
  const start = originalPosition(
    editedFiles?.get(sourceFile.fileName),
    name.getStart(sourceFile)
  );
  return `${sourceFile.fileName}:${start}`;
}

function typeText(checker, node) {
  try {
    return checker.typeToString(
      checker.getTypeAtLocation(node),
      undefined,
      TYPE_FORMAT
    );
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

function editedProgram(program, files) {
  const options = program.getCompilerOptions();
  const host = ts.createCompilerHost(options, true);
  const readSource = host.getSourceFile;
  host.getSourceFile = (fileName, languageVersion, ...rest) => {
    const edited = files.get(fileName);
    if (edited) {
      return ts.createSourceFile(
        fileName,
        edited.text,
        languageVersion,
        true,
        edited.sourceFile.scriptKind
      );
    }
    return (
      parsedSourceFile(program, fileName) ??
      readSource(fileName, languageVersion, ...rest)
    );
  };
  return ts.createProgram({
    rootNames: program.getRootFileNames(),
    options,
    host,
    oldProgram: program,
    projectReferences: program.getProjectReferences(),
  });
}

function diagnosticCounts(program, sourceFile) {
  const counts = new Map();
  for (const diagnostic of [
    ...program.getSyntacticDiagnostics(sourceFile),
    ...program.getSemanticDiagnostics(sourceFile),
  ]) {
    if (diagnostic.reportsUnnecessary) continue;
    const key = `TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function baselineCounts(program, sourceFile) {
  const baselines = diagnosticBaselines.get(program) ?? new Map();
  diagnosticBaselines.set(program, baselines);
  if (!baselines.has(sourceFile.fileName)) {
    baselines.set(sourceFile.fileName, diagnosticCounts(program, sourceFile));
  }
  return baselines.get(sourceFile.fileName);
}

function introducedDiagnostic(program, edited, files) {
  for (const { sourceFile } of files.values()) {
    const before = baselineCounts(program, sourceFile);
    const after = diagnosticCounts(
      edited,
      edited.getSourceFile(sourceFile.fileName)
    );
    for (const [key, count] of after) {
      if (count > (before.get(key) ?? 0)) {
        return `${key} in ${sourceFile.fileName}`;
      }
    }
  }
  return null;
}

function siteProbeHazard(program, edited, files, site) {
  const checker = program.getTypeChecker();
  const editedChecker = edited.getTypeChecker();
  const newSourceFile = edited.getSourceFile(
    site.call.getSourceFile().fileName
  );
  const start = site.edit.newStart;
  const inlined = expressionSpanning(
    newSourceFile,
    start,
    start + site.text.length
  );
  if (!inlined) {
    return `inlined text is not one expression at ${locationOf(site.call)}`;
  }
  if (!ts.isExpressionStatement(site.call.parent)) {
    const before = typeText(checker, site.call);
    const after = typeText(editedChecker, inlined);
    if (before === null || after === null) {
      return `call type is too deep to print and compare at ${locationOf(site.call)}`;
    }
    if (before !== after) {
      return `call type changes from ${before} to ${after} at ${locationOf(site.call)}`;
    }
  }
  for (const { offset, free } of site.offsets) {
    const identifier = referenceAt(newSourceFile, start + offset).identifier;
    const before = bindingKey(checker, free.symbol);
    const after = bindingKey(
      editedChecker,
      identifier && editedChecker.getSymbolAtLocation(identifier),
      files
    );
    if (before !== after) {
      return `${free.node.text} resolves to another binding at ${locationOf(site.call)}`;
    }
  }
  return null;
}

export function editedProgramHazard(program, files, sites) {
  const edited = editedProgram(program, files);
  const introduced = introducedDiagnostic(program, edited, files);
  if (introduced) return introduced;
  for (const site of sites) {
    const hazard = siteProbeHazard(program, edited, files, site);
    if (hazard) return hazard;
  }
  return null;
}

const assignedSymbolSets = new WeakMap();

function assignmentTargets(target, found) {
  const node = unwrapped(target);
  if (ts.isIdentifier(node)) found.push(node);
  else if (ts.isArrayLiteralExpression(node)) {
    for (const element of node.elements) {
      assignmentTargets(
        ts.isSpreadElement(element) ? element.expression : element,
        found
      );
    }
  } else if (ts.isObjectLiteralExpression(node)) {
    for (const property of node.properties) {
      if (ts.isPropertyAssignment(property)) {
        assignmentTargets(property.initializer, found);
      } else if (ts.isShorthandPropertyAssignment(property)) {
        found.push(property.name);
      } else if (ts.isSpreadAssignment(property)) {
        assignmentTargets(property.expression, found);
      }
    }
  } else if (ts.isBinaryExpression(node)) {
    assignmentTargets(node.left, found);
  }
}

function isAssignmentOperator(kind) {
  return (
    kind >= ts.SyntaxKind.FirstAssignment &&
    kind <= ts.SyntaxKind.LastAssignment
  );
}

function assignedSymbols(checker, sourceFile) {
  const byFile = assignedSymbolSets.get(checker) ?? new WeakMap();
  assignedSymbolSets.set(checker, byFile);
  if (byFile.has(sourceFile)) return byFile.get(sourceFile);
  const targets = [];
  function visit(node) {
    if (
      ts.isBinaryExpression(node) &&
      isAssignmentOperator(node.operatorToken.kind)
    ) {
      assignmentTargets(node.left, targets);
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      assignmentTargets(node.operand, targets);
    } else if (
      (ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
      !ts.isVariableDeclarationList(node.initializer)
    ) {
      assignmentTargets(node.initializer, targets);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  const symbols = new Set(
    targets.map((identifier) =>
      ts.isShorthandPropertyAssignment(identifier.parent)
        ? checker.getShorthandAssignmentValueSymbol(identifier.parent)
        : checker.getSymbolAtLocation(identifier)
    )
  );
  byFile.set(sourceFile, symbols);
  return symbols;
}

function isNeverReassigned(checker, symbol) {
  const declaration = symbol.valueDeclaration;
  if (!declaration || declaration.getSourceFile().isDeclarationFile) {
    return false;
  }
  return !assignedSymbols(checker, declaration.getSourceFile()).has(symbol);
}

function stableBinding(checker, symbol) {
  if (!symbol) return false;
  const target = targetOf(checker, symbol);
  if (
    target.flags &
    (ts.SymbolFlags.Function |
      ts.SymbolFlags.Class |
      ts.SymbolFlags.Enum |
      ts.SymbolFlags.EnumMember |
      ts.SymbolFlags.ValueModule)
  ) {
    return true;
  }
  const declaration = target.valueDeclaration;
  if (!declaration) return symbol.escapedName === "undefined";
  if (
    ts.isVariableDeclaration(declaration) &&
    ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const
  ) {
    return true;
  }
  return (
    (ts.isVariableDeclaration(declaration) || ts.isParameter(declaration)) &&
    isNeverReassigned(checker, target)
  );
}

function typeHasFlag(type, flags) {
  return type.isUnion()
    ? type.types.some((member) => member.flags & flags)
    : Boolean(type.flags & flags);
}

function isPrimitive(checker, node) {
  const type = checker.getTypeAtLocation(node);
  return type.isUnion()
    ? type.types.every((member) => member.flags & PRIMITIVE_TYPES)
    : Boolean(type.flags & PRIMITIVE_TYPES);
}

function isConstAsserted(objectLiteral) {
  let node = objectLiteral;
  while (
    ts.isObjectLiteralExpression(node) ||
    ts.isArrayLiteralExpression(node) ||
    ts.isPropertyAssignment(node) ||
    ts.isParenthesizedExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    node = node.parent;
    if (ts.isAsExpression(node) && ts.isConstTypeReference(node.type)) {
      return true;
    }
  }
  return false;
}

function isImmutableDataField(declaration) {
  const modifiers = ts.getCombinedModifierFlags(declaration);
  if (ts.isPropertyDeclaration(declaration)) {
    return (
      ts.isClassLike(declaration.parent) &&
      Boolean(modifiers & ts.ModifierFlags.Readonly) &&
      !(modifiers & (ts.ModifierFlags.Abstract | ts.ModifierFlags.Accessor))
    );
  }
  return (
    (ts.isPropertyAssignment(declaration) ||
      ts.isShorthandPropertyAssignment(declaration) ||
      ts.isMethodDeclaration(declaration)) &&
    ts.isObjectLiteralExpression(declaration.parent) &&
    isConstAsserted(declaration.parent)
  );
}

function memberStep(program, node) {
  const checker = program.getTypeChecker();
  const object = checker.getTypeAtLocation(node.expression);
  if (typeHasFlag(object, NULLISH_OR_UNKNOWN)) return "effect";
  if (
    ts.isElementAccessExpression(node) &&
    !ts.isStringLiteralLike(node.argumentExpression) &&
    !ts.isNumericLiteral(node.argumentExpression)
  ) {
    return "effect";
  }
  const symbol = checker.getSymbolAtLocation(
    ts.isPropertyAccessExpression(node) ? node.name : node.argumentExpression
  );
  const declarations = symbol?.declarations ?? [];
  const receiver = unwrapped(node.expression);
  const stableReceiver = ts.isIdentifier(receiver)
    ? stableBinding(checker, checker.getSymbolAtLocation(receiver))
    : (ts.isPropertyAccessExpression(receiver) ||
        ts.isElementAccessExpression(receiver)) &&
      memberStep(program, receiver) === "read";
  return declarations.length > 0 &&
    stableReceiver &&
    declarations.every(isImmutableDataField)
    ? "read"
    : "effect";
}

const STEP_RANK = { immutable: 0, read: 1, effect: 2 };

export function strongerStep(left, right) {
  return STEP_RANK[right] > STEP_RANK[left] ? right : left;
}

export function stepsCommute(preceding, following) {
  return (
    preceding === "immutable" ||
    following === "immutable" ||
    (preceding === "read" && following === "read")
  );
}

function isImmutableNode(node) {
  return (
    (LITERAL_KINDS.has(node.kind) && !ts.isTemplateExpression(node)) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node)
  );
}

function evaluationStepper(program, parameterSymbols) {
  const checker = program.getTypeChecker();
  const steps = { order: [], modelled: true };
  function name(node, symbol) {
    const index = parameterSymbols.indexOf(symbol);
    if (index >= 0) steps.order.push({ slot: index, node });
    else {
      steps.order.push({
        step: stableBinding(checker, symbol) ? "immutable" : "read",
        node,
      });
    }
  }
  function spread(node) {
    visit(node.expression);
    steps.order.push({ step: "effect", node });
  }
  function visitMember(node) {
    visit(node.expression);
    if (ts.isElementAccessExpression(node)) visit(node.argumentExpression);
    steps.order.push({ step: memberStep(program, node), node });
  }
  function visitCall(node) {
    visit(node.expression);
    for (const argument of node.arguments) {
      if (ts.isSpreadElement(argument)) spread(argument);
      else visit(argument);
    }
    steps.order.push({ step: "effect", node });
  }
  function visitTemplate(node) {
    for (const span of node.templateSpans) {
      visit(span.expression);
      steps.order.push({
        step: isPrimitive(checker, span.expression) ? "immutable" : "effect",
        node: span.expression,
      });
    }
  }
  function visitArray(node) {
    for (const element of node.elements) {
      if (ts.isSpreadElement(element)) spread(element);
      else if (!ts.isOmittedExpression(element)) visit(element);
    }
  }
  function visitProperty(property) {
    if (ts.isPropertyAssignment(property)) {
      if (ts.isComputedPropertyName(property.name)) {
        visit(property.name.expression);
      }
      visit(property.initializer);
    } else if (ts.isShorthandPropertyAssignment(property)) {
      name(property.name, checker.getShorthandAssignmentValueSymbol(property));
    } else if (ts.isSpreadAssignment(property)) {
      spread(property);
    } else {
      steps.order.push({ step: "immutable", node: property });
    }
  }
  function visit(node) {
    const expression = unwrapped(node);
    if (ts.isIdentifier(expression)) {
      name(expression, checker.getSymbolAtLocation(expression));
    } else if (isImmutableNode(expression)) {
      steps.order.push({ step: "immutable", node: expression });
    } else if (
      (ts.isPropertyAccessExpression(expression) ||
        ts.isElementAccessExpression(expression)) &&
      !expression.questionDotToken
    ) {
      visitMember(expression);
    } else if (
      ts.isCallExpression(expression) &&
      !expression.questionDotToken
    ) {
      visitCall(expression);
    } else if (ts.isTemplateExpression(expression)) {
      visitTemplate(expression);
    } else if (ts.isArrayLiteralExpression(expression)) {
      visitArray(expression);
    } else if (ts.isObjectLiteralExpression(expression)) {
      expression.properties.forEach(visitProperty);
    } else {
      steps.modelled = false;
      steps.order.push({ step: "effect", node: expression });
    }
  }
  return { steps, visit };
}

function parameterSymbolsOf(program, functionNode) {
  const checker = program.getTypeChecker();
  return functionNode.parameters.map((parameter) =>
    checker.getSymbolAtLocation(parameter.name)
  );
}

export function bodyEvaluationOrder(program, functionNode) {
  const { body } = functionNode;
  const stepper = evaluationStepper(
    program,
    parameterSymbolsOf(program, functionNode)
  );
  stepper.visit(ts.isBlock(body) ? body.statements[0].expression : body);
  return stepper.steps;
}

export function argumentEffect(program, functionNode, call, index) {
  const argumentsForSlot = functionNode.parameters[index].dotDotDotToken
    ? call.arguments.slice(index)
    : call.arguments.slice(index, index + 1);
  let strongest = "immutable";
  for (const argument of argumentsForSlot) {
    const stepper = evaluationStepper(program, []);
    stepper.visit(argument);
    const effect = stepper.steps.modelled
      ? stepper.steps.order.reduce(
          (current, { step }) => strongerStep(current, step),
          "immutable"
        )
      : "effect";
    strongest = strongerStep(strongest, effect);
  }
  return strongest;
}
