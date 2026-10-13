import { posix } from "node:path";

import ts from "typescript";

import { publicSurface } from "./package-entry-points.js";
import {
  bindingAtSite,
  bodyBindings,
  argumentEffect,
  bodyEvaluationOrder,
  declaredContract,
  editedProgramHazard,
  importOfFile,
  locationOf,
  programReferences,
} from "./typescript-engine.js";

const STEP_RANK = { immutable: 0, read: 1, effect: 2 };
const BARE_ARGUMENT_KINDS = new Set([
  ts.SyntaxKind.Identifier,
  ts.SyntaxKind.PropertyAccessExpression,
  ts.SyntaxKind.ElementAccessExpression,
  ts.SyntaxKind.CallExpression,
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NumericLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateExpression,
  ts.SyntaxKind.ArrayLiteralExpression,
  ts.SyntaxKind.ParenthesizedExpression,
  ts.SyntaxKind.ThisKeyword,
  ts.SyntaxKind.TrueKeyword,
  ts.SyntaxKind.FalseKeyword,
  ts.SyntaxKind.NullKeyword,
]);

function rejected(reason) {
  return { hop: false, reason };
}

function isExported(declaration, references) {
  return (
    Boolean(
      ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Export
    ) || references.export.length > 0
  );
}

function ownerReason(references, bindings, surface) {
  const identity = references.identity[0];
  if (identity) {
    return `referenced by identity (${identity.use}) at ${locationOf(identity.node)}`;
  }
  if (surface.owner) return surface.owner;
  const callerModules = new Set(
    references.call.map(({ node }) => node.getSourceFile())
  );
  if (bindings.boundLiterals > 0 && callerModules.size >= 2) {
    return `binds a literal and is called from ${callerModules.size} modules`;
  }
  return null;
}

function parameterHazard(functionNode, uses) {
  const order = uses.map(({ index }) => index);
  const expected = functionNode.parameters.map((_parameter, index) => index);
  if (order.join() === expected.join()) return null;
  const counts = expected.map(
    (index) => order.filter((used) => used === index).length
  );
  const misused = counts.findIndex((count) => count !== 1);
  if (misused >= 0) {
    return `parameter ${functionNode.parameters[misused].name.getText()} is used ${counts[misused]} times`;
  }
  return "parameters are evaluated in a different order";
}

function unwrapped(node) {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function orderHazard(program, context, call) {
  let preceding = { step: "immutable" };
  for (const entry of context.order) {
    if (entry.slot === undefined) {
      if (STEP_RANK[entry.step] > STEP_RANK[preceding.step]) preceding = entry;
      continue;
    }
    const argument = argumentEffect(
      program,
      context.functionNode,
      call,
      entry.slot
    );
    const commutes =
      preceding.step === "immutable" ||
      argument === "immutable" ||
      (preceding.step === "read" && argument === "read");
    if (!commutes) {
      return `argument ${entry.slot + 1} at ${locationOf(call)} would be evaluated after ${preceding.node.getText()} instead of before it`;
    }
  }
  return null;
}

function argumentTexts(functionNode, call) {
  const sourceFile = call.getSourceFile();
  return functionNode.parameters.map((parameter, index) => {
    if (parameter.dotDotDotToken) {
      return `[${call.arguments
        .slice(index)
        .map((argument) => argument.getText(sourceFile))
        .join(", ")}]`;
    }
    const argument = call.arguments[index];
    if (!argument) return "undefined";
    const text = argument.getText(sourceFile);
    return BARE_ARGUMENT_KINDS.has(argument.kind) ? text : `(${text})`;
  });
}

function siteHazard(functionNode, call) {
  const hasRest = functionNode.parameters.some(
    (parameter) => parameter.dotDotDotToken
  );
  if (call.questionDotToken) return "optional call";
  if (call.typeArguments) return "explicit type arguments";
  if (call.arguments.some(ts.isSpreadElement)) return "spread argument";
  if (!hasRest && call.arguments.length > functionNode.parameters.length) {
    return "extra arguments would no longer be evaluated";
  }
  return null;
}

function calleeArgument(use, argumentText, argument) {
  const parent = use.node.parent;
  const isCallee =
    ts.isCallExpression(parent) && parent.expression === use.node;
  const target = argument && unwrapped(argument);
  return isCallee &&
    target &&
    (ts.isPropertyAccessExpression(target) ||
      ts.isElementAccessExpression(target))
    ? `(0, ${argumentText})`
    : argumentText;
}

function inlinedText(body, bindings, call, functionNode) {
  const sourceFile = body.getSourceFile();
  const argumentTextsByParameter = argumentTexts(functionNode, call);
  const slots = [
    ...bindings.uses.map((use) => ({ ...use, parameter: true })),
    ...bindings.free,
  ].sort((left, right) => left.node.getStart() - right.node.getStart());
  let text = "";
  let cursor = body.getStart(sourceFile);
  const offsets = [];
  for (const slot of slots) {
    text += sourceFile.text.slice(cursor, slot.node.getStart(sourceFile));
    const prefix = slot.shorthand ? `${slot.node.text}: ` : "";
    if (slot.parameter) {
      text +=
        prefix +
        calleeArgument(
          slot,
          argumentTextsByParameter[slot.index],
          call.arguments[slot.index]
        );
    } else {
      text += prefix;
      offsets.push({ offset: text.length, free: slot });
      text += slot.node.text;
    }
    cursor = slot.node.end;
  }
  return { text: text + sourceFile.text.slice(cursor, body.end), offsets };
}

function relocatedSpecifier(specifier, fromFile, toFile) {
  if (!specifier.startsWith(".")) return specifier;
  const target = posix.join(posix.dirname(fromFile), specifier);
  const relocated = posix.relative(posix.dirname(toFile), target);
  return relocated.startsWith(".") ? relocated : `./${relocated}`;
}

function specifierStyle(specifier, fileName) {
  if (/\.[cm]?js$/u.test(specifier)) {
    return fileName.replace(/\.([cm]?)tsx?$/u, ".$1js");
  }
  if (/\.[cm]?tsx?$/u.test(specifier)) return fileName;
  return fileName.replace(/(?:\/index)?\.[cm]?tsx?$/u, "");
}

function specifierToFunctionFile(context, siteFile) {
  const { program, functionFile } = context;
  const direct = importOfFile(program, siteFile, functionFile);
  if (direct) return direct.moduleSpecifier.text;
  const relativeImport = siteFile.statements.find(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      statement.moduleSpecifier.text.startsWith(".")
  );
  const path = posix.relative(
    posix.dirname(siteFile.fileName),
    functionFile.fileName
  );
  return specifierStyle(
    relativeImport?.moduleSpecifier.text ?? "",
    path.startsWith(".") ? path : `./${path}`
  );
}

function importLine(context, free, siteFile) {
  const { origin, node } = free;
  const name = node.text;
  if (origin.kind === "module") {
    return `import { ${name} } from ${JSON.stringify(specifierToFunctionFile(context, siteFile))};`;
  }
  const declaration = origin.declaration;
  const importDeclaration = ts.findAncestor(
    declaration,
    ts.isImportDeclaration
  );
  if (!importDeclaration) return null;
  const specifier = JSON.stringify(
    relocatedSpecifier(
      importDeclaration.moduleSpecifier.text,
      context.functionFile.fileName,
      siteFile.fileName
    )
  );
  if (ts.isNamespaceImport(declaration)) {
    return `import * as ${name} from ${specifier};`;
  }
  if (ts.isImportClause(declaration)) {
    return `import ${name} from ${specifier};`;
  }
  const imported = declaration.propertyName?.getText() ?? name;
  return `import { ${imported === name ? name : `${imported} as ${name}`} } from ${specifier};`;
}

function exposeDependency(context, origin) {
  if (
    origin.kind !== "module" ||
    ts.getCombinedModifierFlags(origin.declaration) & ts.ModifierFlags.Export
  ) {
    return;
  }
  const start = origin.statement.getStart(context.functionFile);
  context.edits.add(context.functionFile, start, start, "export ");
}

function siteImports(context, site) {
  const { program, bindings, functionFile, edits } = context;
  const siteFile = site.getSourceFile();
  if (siteFile === functionFile) return null;
  for (const free of bindings.free) {
    if (free.origin.kind === "local") {
      return `closes over local ${free.node.text}`;
    }
    const binding = bindingAtSite(program, free, site);
    if (binding === "other") {
      return `${free.node.text} names another binding at ${locationOf(site)}`;
    }
    if (binding === "same" || free.origin.kind === "global") continue;
    const line = importLine(context, free, siteFile);
    if (!line) {
      return `${free.node.text} comes from an import form that cannot move`;
    }
    edits.addImport(siteFile, line);
    exposeDependency(context, free.origin);
  }
  return null;
}

function editSet() {
  const byFile = new Map();
  const imports = new Map();
  return {
    byFile,
    imports,
    add(sourceFile, start, end, text) {
      const list = byFile.get(sourceFile) ?? [];
      byFile.set(sourceFile, list);
      const existing = list.find(
        (edit) => edit.start === start && edit.end === end
      );
      if (existing) return existing;
      const edit = { start, end, text };
      list.push(edit);
      return edit;
    },
    addImport(sourceFile, line) {
      const lines = imports.get(sourceFile) ?? new Set();
      lines.add(line);
      imports.set(sourceFile, lines);
    },
  };
}

function importInsertion(sourceFile) {
  const statements = sourceFile.statements;
  const lastImport = statements.findLast(ts.isImportDeclaration);
  if (lastImport) return lastImport.end;
  const prologue = statements.findIndex(
    (statement) =>
      !ts.isExpressionStatement(statement) ||
      !ts.isStringLiteral(statement.expression)
  );
  return prologue > 0 ? statements[prologue - 1].end : 0;
}

function remainingElements(edits, element) {
  const list = element.parent;
  const sourceFile = element.getSourceFile();
  const remaining = list.elements.filter((other) => other !== element);
  if (remaining.length === 0) return false;
  edits.add(
    sourceFile,
    list.getStart(sourceFile),
    list.end,
    `{ ${remaining.map((other) => other.getText(sourceFile)).join(", ")} }`
  );
  return true;
}

function removeImport(edits, specifier) {
  if (remainingElements(edits, specifier)) return;
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

function removeExport(edits, specifier) {
  if (remainingElements(edits, specifier)) return;
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

function removeDeclaration(edits, declaration) {
  const sourceFile = declaration.getSourceFile();
  if (
    ts.isVariableDeclaration(declaration) &&
    declaration.parent.declarations.length > 1
  ) {
    const siblings = declaration.parent.declarations;
    const index = siblings.indexOf(declaration);
    const next = siblings[index + 1];
    edits.add(
      sourceFile,
      next ? declaration.getStart(sourceFile) : siblings[index - 1].end,
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

function orderedEdits(edits) {
  const files = new Map();
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
        (edit, index) => index > 0 && edit.start < sorted[index - 1].end
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

function planSites(context) {
  const { functionNode, call, bindings, references, edits } = context;
  for (const { node: siteCall } of references.call) {
    const hazard =
      siteHazard(functionNode, siteCall) ??
      orderHazard(context.program, context, siteCall) ??
      siteImports(context, siteCall);
    if (hazard) return hazard;
    const inlined = inlinedText(call, bindings, siteCall, functionNode);
    const edit = edits.add(
      siteCall.getSourceFile(),
      siteCall.getStart(),
      siteCall.end,
      inlined.text
    );
    context.sites.push({ call: siteCall, edit, ...inlined });
  }
  for (const { node } of references.import) removeImport(edits, node);
  for (const { node } of references.export) removeExport(edits, node);
  removeDeclaration(edits, context.declaration);
  return null;
}

function verifyEdits(context) {
  const hazard = planSites(context);
  if (hazard) return rejected(hazard);
  const files = orderedEdits(context.edits);
  if (!files) return rejected("call sites overlap");
  const introduced = editedProgramHazard(context.program, files, context.sites);
  if (introduced) return rejected(introduced);
  if (context.incomplete) return { hop: false, incomplete: context.incomplete };
  return {
    hop: true,
    calls: context.sites.length,
    fix: new Map([...files].map(([fileName, { text }]) => [fileName, text])),
  };
}

export function verifyHop(program, candidate) {
  const { declaration, functionNode, nameNode, call } = candidate;
  const contract = declaredContract(program, declaration, nameNode);
  if (contract) return rejected(contract);
  const references = programReferences(program, nameNode);
  const bindings = bodyBindings(program, functionNode, call);
  const surface = isExported(declaration, references)
    ? publicSurface(program, nameNode)
    : {};
  const owner = ownerReason(references, bindings, surface);
  if (owner) return rejected(owner);
  const { order, modelled } = bodyEvaluationOrder(program, functionNode);
  const hazard =
    bindings.hazards[0] ??
    parameterHazard(functionNode, bindings.uses) ??
    (modelled ? null : "the body's evaluation order is not modelled");
  if (hazard) return rejected(hazard);
  return verifyEdits({
    program,
    declaration,
    functionNode,
    call,
    bindings,
    references,
    functionFile: nameNode.getSourceFile(),
    order,
    incomplete: surface.incomplete,
    edits: editSet(),
    sites: [],
  });
}
