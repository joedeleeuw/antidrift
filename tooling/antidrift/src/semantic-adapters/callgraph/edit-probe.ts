import ts from "typescript";
import type { TextEdit, EditedFile } from "./inline-edits.ts";
import type { FreeBinding } from "./body-bindings.ts";
import { parsedSourceFile, targetOf } from "../provenance/package-program.ts";
import { locationOf } from "../kernel/expression-wrappers.ts";
import { referenceAt } from "./program-references.ts";

const diagnosticBaselines = new WeakMap<
  ts.Program,
  Map<string, Map<string, number>>
>();
const TYPE_FORMAT =
  ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseFullyQualifiedType;
export type InlineSite = {
  readonly call: ts.CallExpression;
  readonly edit: TextEdit;
  readonly text: string;
  readonly offsets: readonly {
    readonly offset: number;
    readonly free: FreeBinding;
  }[];
};
function expressionSpanning(
  sourceFile: ts.SourceFile,
  start: number,
  end: number
) {
  let node: ts.Node | undefined = sourceFile;
  while (node) {
    if (node.getStart(sourceFile) === start && node.end === end) {
      return node;
    }
    node = ts.forEachChild(node, (child) =>
      child.pos <= start && start < child.end ? child : undefined
    );
  }
  return undefined;
}
function originalPosition(edited: EditedFile | undefined, position: number) {
  let delta = 0;
  for (const edit of edited?.edits ?? []) {
    if (edit.newStart === undefined) {
      throw new TypeError(`Unapplied edit in ${edited?.sourceFile.fileName}`);
    }
    const newEnd = edit.newStart + edit.text.length;
    if (position < edit.newStart) {
      break;
    }
    if (position < newEnd) {
      return null;
    }
    delta = newEnd - edit.end;
  }
  return position - delta;
}
function bindingKey(
  checker: ts.TypeChecker,
  symbol: ts.Symbol | undefined,
  editedFiles?: ReadonlyMap<string, EditedFile>
) {
  if (!symbol) {
    return "unresolved";
  }
  const target = targetOf(checker, symbol);
  const declaration = target.valueDeclaration ?? target.declarations?.[0];
  if (!declaration) {
    return `global ${target.escapedName}`;
  }
  const sourceFile = declaration.getSourceFile();
  const name =
    (ts.isNamedDeclaration(declaration) ? declaration.name : undefined) ??
    declaration;
  const start = originalPosition(
    editedFiles?.get(sourceFile.fileName),
    name.getStart(sourceFile)
  );
  return `${sourceFile.fileName}:${start}`;
}
function typeText(checker: ts.TypeChecker, node: ts.Node) {
  try {
    return checker.typeToString(
      checker.getTypeAtLocation(node),
      undefined,
      TYPE_FORMAT
    );
  } catch (error) {
    if (error instanceof RangeError) {
      return null;
    }
    throw error;
  }
}
function editedProgram(
  program: ts.Program,
  files: ReadonlyMap<string, EditedFile>
) {
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
  const projectReferences = program.getProjectReferences();
  return ts.createProgram({
    rootNames: program.getRootFileNames(),
    options,
    host,
    oldProgram: program,
    ...(projectReferences ? { projectReferences } : {}),
  });
}
function diagnosticCounts(program: ts.Program, sourceFile: ts.SourceFile) {
  const counts = new Map<string, number>();
  for (const diagnostic of [
    ...program.getSyntacticDiagnostics(sourceFile),
    ...program.getSemanticDiagnostics(sourceFile),
  ]) {
    if (diagnostic.reportsUnnecessary) {
      continue;
    }
    const key = `TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}
function baselineCounts(program: ts.Program, sourceFile: ts.SourceFile) {
  const baselines =
    diagnosticBaselines.get(program) ?? new Map<string, Map<string, number>>();
  diagnosticBaselines.set(program, baselines);
  const existing = baselines.get(sourceFile.fileName);
  if (existing) {
    return existing;
  }
  const counts = diagnosticCounts(program, sourceFile);
  baselines.set(sourceFile.fileName, counts);
  return counts;
}
function introducedDiagnostic(
  program: ts.Program,
  edited: ts.Program,
  files: ReadonlyMap<string, EditedFile>
) {
  for (const { sourceFile } of files.values()) {
    const before = baselineCounts(program, sourceFile);
    const after = diagnosticCounts(
      edited,
      requireSourceFile(edited, sourceFile.fileName)
    );
    for (const [key, count] of after) {
      if (count > (before.get(key) ?? 0)) {
        return `${key} in ${sourceFile.fileName}`;
      }
    }
  }
  return null;
}
function siteProbeHazard(
  program: ts.Program,
  edited: ts.Program,
  files: ReadonlyMap<string, EditedFile>,
  site: InlineSite
) {
  const checker = program.getTypeChecker();
  const editedChecker = edited.getTypeChecker();
  const newSourceFile = requireSourceFile(
    edited,
    site.call.getSourceFile().fileName
  );
  const start = site.edit.newStart;
  if (start === undefined) {
    throw new TypeError("Inline edit has not been applied");
  }
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
export function editedProgramHazard(
  program: ts.Program,
  files: ReadonlyMap<string, EditedFile>,
  sites: readonly InlineSite[]
) {
  const edited = editedProgram(program, files);
  const introduced = introducedDiagnostic(program, edited, files);
  if (introduced) {
    return introduced;
  }
  for (const site of sites) {
    const hazard = siteProbeHazard(program, edited, files, site);
    if (hazard) {
      return hazard;
    }
  }
  return null;
}
function requireSourceFile(program: ts.Program, fileName: string) {
  const source = program.getSourceFile(fileName);
  if (!source) {
    throw new TypeError(`Edited program is missing ${fileName}`);
  }
  return source;
}
