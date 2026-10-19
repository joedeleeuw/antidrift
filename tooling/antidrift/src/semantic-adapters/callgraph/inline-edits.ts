import ts from "typescript";

export type TextEdit = {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  newStart?: number;
};
export type EditedFile = {
  readonly sourceFile: ts.SourceFile;
  readonly edits: readonly TextEdit[];
  readonly text: string;
};
export type EditSet = ReturnType<typeof editSet>;
function requireSibling(
  siblings: readonly ts.VariableDeclaration[],
  index: number
) {
  const sibling = siblings[index];
  if (!sibling) {
    throw new TypeError(`No declaration sibling at index ${index}`);
  }
  return sibling;
}
export function editSet() {
  const byFile = new Map<ts.SourceFile, TextEdit[]>();
  const imports = new Map<ts.SourceFile, Set<string>>();
  return {
    byFile,
    imports,
    add(sourceFile: ts.SourceFile, start: number, end: number, text: string) {
      const list = byFile.get(sourceFile) ?? [];
      byFile.set(sourceFile, list);
      const existing = list.find(
        (edit) => edit.start === start && edit.end === end
      );
      if (existing) {
        return existing;
      }
      const edit: TextEdit = { start, end, text };
      list.push(edit);
      return edit;
    },
    addImport(sourceFile: ts.SourceFile, line: string) {
      const lines = imports.get(sourceFile) ?? new Set();
      lines.add(line);
      imports.set(sourceFile, lines);
    },
  };
}
function importInsertion(sourceFile: ts.SourceFile) {
  const statements = sourceFile.statements;
  const lastImport = statements.findLast(ts.isImportDeclaration);
  if (lastImport) {
    return lastImport.end;
  }
  const prologue = statements.findIndex(
    (statement) =>
      !ts.isExpressionStatement(statement) ||
      !ts.isStringLiteral(statement.expression)
  );
  return prologue > 0 ? (statements[prologue - 1]?.end ?? 0) : 0;
}
function remainingElements(
  edits: EditSet,
  element: ts.ImportSpecifier | ts.ExportSpecifier
) {
  const list = element.parent;
  const sourceFile = element.getSourceFile();
  const remaining = [...list.elements].filter((other) => other !== element);
  if (remaining.length === 0) {
    return false;
  }
  edits.add(
    sourceFile,
    list.getStart(sourceFile),
    list.end,
    `{ ${remaining.map((other) => other.getText(sourceFile)).join(", ")} }`
  );
  return true;
}
export function removeImport(edits: EditSet, specifier: ts.ImportSpecifier) {
  if (remainingElements(edits, specifier)) {
    return;
  }
  const sourceFile = specifier.getSourceFile();
  const clause = specifier.parent.parent;
  const declaration = clause.parent;
  if (clause.name) {
    edits.add(sourceFile, clause.name.end, specifier.parent.end, "");
    return;
  }
  edits.add(
    sourceFile,
    declaration.getStart(sourceFile),
    declaration.end,
    `import ${declaration.moduleSpecifier.getText(sourceFile)};`
  );
}
export function removeExport(edits: EditSet, specifier: ts.ExportSpecifier) {
  if (remainingElements(edits, specifier)) {
    return;
  }
  const sourceFile = specifier.getSourceFile();
  const declaration = specifier.parent.parent;
  edits.add(
    sourceFile,
    declaration.getStart(sourceFile),
    declaration.end,
    declaration.moduleSpecifier
      ? `import ${declaration.moduleSpecifier.getText(sourceFile)};`
      : ""
  );
}
export function removeDeclaration(
  edits: EditSet,
  declaration: ts.VariableDeclaration | ts.FunctionDeclaration
) {
  const sourceFile = declaration.getSourceFile();
  if (
    ts.isVariableDeclaration(declaration) &&
    ts.isVariableDeclarationList(declaration.parent) &&
    declaration.parent.declarations.length > 1
  ) {
    const siblings = declaration.parent.declarations;
    const index = siblings.indexOf(declaration);
    const next = siblings[index + 1];
    edits.add(
      sourceFile,
      next
        ? declaration.getStart(sourceFile)
        : requireSibling(siblings, index - 1).end,
      next ? next.getStart(sourceFile) : declaration.end,
      ""
    );
    return;
  }
  const statement = ts.isVariableDeclaration(declaration)
    ? declaration.parent.parent
    : declaration;
  edits.add(sourceFile, statement.getStart(sourceFile), statement.end, "");
}
export function orderedEdits(edits: EditSet) {
  const files = new Map<string, EditedFile>();
  for (const [sourceFile, lines] of edits.imports) {
    const position = importInsertion(sourceFile);
    edits.add(sourceFile, position, position, `\n${[...lines].join("\n")}\n`);
  }
  for (const [sourceFile, list] of edits.byFile) {
    const sorted = list.toSorted(
      (left, right) => left.start - right.start || left.end - right.end
    );
    if (
      sorted.some(
        (edit, index) => index > 0 && edit.start < (sorted[index - 1]?.end ?? 0)
      )
    ) {
      return null;
    }
    let text = "";
    let cursor = 0;
    for (const edit of sorted) {
      text += sourceFile.text.slice(cursor, edit.start);
      edit.newStart = text.length;
      text += edit.text;
      cursor = edit.end;
    }
    files.set(sourceFile.fileName, {
      sourceFile,
      edits: sorted,
      text: text + sourceFile.text.slice(cursor),
    });
  }
  return files;
}
