import ts from "typescript";
import { parsedSourceFile } from "../provenance/package-program.ts";

const languageServices = new WeakMap<ts.Program, ts.LanguageService>();
type Reference =
  | {
      readonly kind: "declaration";
    }
  | {
      readonly kind: "call";
      readonly node: ts.CallExpression;
    }
  | {
      readonly kind: "import";
      readonly node: ts.ImportSpecifier;
    }
  | {
      readonly kind: "export";
      readonly node: ts.ExportSpecifier;
    }
  | {
      readonly kind: "identity";
      readonly node: ts.Node;
      readonly use: string;
    };
export type ProgramReferences = {
  [Kind in Exclude<Reference["kind"], "declaration">]: Omit<
    Extract<
      Reference,
      {
        kind: Kind;
      }
    >,
    "kind"
  >[];
};
function reusingDocumentRegistry(program: ts.Program) {
  const registry = ts.createDocumentRegistry();
  const reuse =
    <Tail extends unknown[]>(
      acquire: (fileName: string, ...rest: Tail) => ts.SourceFile
    ) =>
    (fileName: string, ...rest: Tail) =>
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
function languageServiceOf(program: ts.Program) {
  const existing = languageServices.get(program);
  if (existing) {
    return existing;
  }
  const host = {
    getScriptFileNames: () => [...program.getRootFileNames()],
    getProjectVersion: () => "0",
    getScriptVersion: () => "0",
    getScriptSnapshot(fileName: string) {
      const text =
        program.getSourceFile(fileName)?.text ?? ts.sys.readFile(fileName);
      return text === undefined
        ? undefined
        : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => program.getCurrentDirectory(),
    getCompilationSettings: () => program.getCompilerOptions(),
    getProjectReferences: () => program.getProjectReferences(),
    getDefaultLibFileName: (options: ts.CompilerOptions) =>
      ts.getDefaultLibFilePath(options),
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
    ...(ts.sys.realpath ? { realpath: ts.sys.realpath } : {}),
  };
  const service = ts.createLanguageService(
    host,
    reusingDocumentRegistry(program)
  );
  languageServices.set(program, service);
  return service;
}
function childContaining(node: ts.Node, position: number) {
  return ts.forEachChild(node, (child) =>
    child.pos <= position && position < child.end ? child : undefined
  );
}
export function referenceAt(sourceFile: ts.SourceFile, position: number) {
  let node: ts.Node | undefined = sourceFile;
  while (node) {
    if (
      (ts.isIdentifier(node) || ts.isStringLiteral(node)) &&
      node.getStart(sourceFile) === position
    ) {
      return { identifier: node, comment: undefined };
    }
    if (node !== sourceFile && position < node.getStart(sourceFile)) {
      return { comment: true, identifier: undefined };
    }
    node = childContaining(node, position);
  }
  return { identifier: undefined, comment: undefined };
}
function classifyReference(
  identifier: ts.Identifier | ts.StringLiteral,
  nameNode: ts.Node
): Reference {
  if (identifier === nameNode) {
    return { kind: "declaration" };
  }
  const parent = identifier.parent;
  if (ts.isImportSpecifier(parent)) {
    return { kind: "import", node: parent };
  }
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
export function programReferences(program: ts.Program, nameNode: ts.Node) {
  const sourceFile = nameNode.getSourceFile();
  const referenced = languageServiceOf(program).findReferences(
    sourceFile.fileName,
    nameNode.getStart(sourceFile)
  );
  const call: ProgramReferences["call"] = [];
  const imports: ProgramReferences["import"] = [];
  const exports: ProgramReferences["export"] = [];
  const identity: ProgramReferences["identity"] = [];
  const found = {
    call,
    import: imports,
    export: exports,
    identity,
  } satisfies ProgramReferences;
  const seen = new Set<ts.Node>();
  for (const entry of (referenced ?? []).flatMap(
    ({ references }) => references
  )) {
    const file = program.getSourceFile(entry.fileName);
    const { identifier, comment } = file
      ? referenceAt(file, entry.textSpan.start)
      : {};
    if (comment) {
      continue;
    }
    if (!identifier) {
      found.identity.push({ node: nameNode, use: "unmapped reference" });
      continue;
    }
    const reference = classifyReference(identifier, nameNode);
    if (reference.kind === "declaration" || seen.has(reference.node)) {
      continue;
    }
    seen.add(reference.node);
    switch (reference.kind) {
      case "call":
        found.call.push(reference);
        break;
      case "import":
        found.import.push(reference);
        break;
      case "export":
        found.export.push(reference);
        break;
      case "identity":
        found.identity.push(reference);
        break;
    }
  }
  return found;
}
export function declaredContract(
  program: ts.Program,
  declaration: ts.Declaration,
  nameNode: ts.Node
) {
  const flags = ts.getCombinedModifierFlags(declaration);
  if (flags & ts.ModifierFlags.Default) {
    return "default export";
  }
  if (flags & ts.ModifierFlags.Ambient) {
    return "ambient declaration";
  }
  const symbol = program.getTypeChecker().getSymbolAtLocation(nameNode);
  if ((symbol?.declarations?.length ?? 0) > 1) {
    return "merged or overloaded declaration";
  }
  return null;
}
