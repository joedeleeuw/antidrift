import { posix } from "node:path";
import ts from "typescript";
import { publicSurface } from "../provenance/package-entry-points.ts";
import { bindingAtSite, bodyBindings, importOfFile } from "./body-bindings.ts";
import type {
  BodyBindings,
  FreeBinding,
  ParameterUse,
} from "./body-bindings.ts";
import {
  argumentEffect,
  bodyEvaluationOrder,
  stepsCommute,
  strongerStep,
} from "./evaluation-order.ts";
import type { EvaluationEntry, EvaluationStep } from "./evaluation-order.ts";
import { declaredContract, programReferences } from "./program-references.ts";
import type { ProgramReferences } from "./program-references.ts";
import { editedProgramHazard } from "./edit-probe.ts";
import type { InlineSite } from "./edit-probe.ts";
import {
  editSet,
  orderedEdits,
  removeImport,
  removeExport,
  removeDeclaration,
} from "./inline-edits.ts";
import type { EditSet } from "./inline-edits.ts";
import {
  locationOf,
  outermostWrapper,
  unwrapped,
} from "../kernel/expression-wrappers.ts";

type HopCandidate = {
  readonly declaration: ts.VariableDeclaration | ts.FunctionDeclaration;
  readonly functionNode:
    | ts.FunctionDeclaration
    | ts.FunctionExpression
    | ts.ArrowFunction;
  readonly nameNode: ts.Identifier;
  readonly call: ts.CallExpression;
};
type HopContext = Omit<HopCandidate, "nameNode"> & {
  readonly program: ts.Program;
  readonly bindings: BodyBindings;
  readonly references: ProgramReferences;
  readonly functionFile: ts.SourceFile;
  readonly order: readonly EvaluationEntry[];
  readonly incomplete: string | undefined;
  readonly edits: EditSet;
  readonly sites: InlineSite[];
};
function requireParameter(
  functionNode: HopCandidate["functionNode"],
  index: number
) {
  const parameter = functionNode.parameters[index];
  if (!parameter) {
    throw new TypeError(`No hop parameter at ${index}`);
  }
  return parameter;
}
function requireArgumentText(texts: readonly string[], index: number) {
  const text = texts[index];
  if (text === undefined) {
    throw new TypeError(`No inlined argument text for parameter ${index}`);
  }
  return text;
}
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
function rejected(reason: string) {
  return { hop: false, reason };
}
function isExported(
  declaration: ts.Declaration,
  references: ProgramReferences
) {
  return (
    Boolean(
      ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Export
    ) || references.export.length > 0
  );
}
function ownerReason(
  references: ProgramReferences,
  bindings: BodyBindings,
  surface: ReturnType<typeof publicSurface>
) {
  const identity = references.identity[0];
  if (identity) {
    return `referenced by identity (${identity.use}) at ${locationOf(identity.node)}`;
  }
  if (surface.owner) {
    return surface.owner;
  }
  const callerModules = new Set(
    references.call.map(({ node }) => node.getSourceFile())
  );
  if (bindings.boundLiterals > 0 && callerModules.size >= 2) {
    return `binds a literal and is called from ${callerModules.size} modules`;
  }
  return null;
}
function parameterHazard(
  functionNode: HopCandidate["functionNode"],
  uses: BodyBindings["uses"]
) {
  const order = uses.map(({ index }) => index);
  const expected = functionNode.parameters.map((_, index) => index);
  if (order.join() === expected.join()) {
    return null;
  }
  const counts = expected.map(
    (index) => order.filter((used) => used === index).length
  );
  const misused = counts.findIndex((count) => count !== 1);
  if (misused >= 0) {
    return `parameter ${requireParameter(functionNode, misused).name.getText()} is used ${counts[misused]} times`;
  }
  return "parameters are evaluated in a different order";
}
function orderHazard(
  program: ts.Program,
  context: HopContext,
  call: ts.CallExpression
) {
  let preceding: Extract<
    EvaluationEntry,
    {
      step: EvaluationStep;
    }
  > | null = null;
  for (const entry of context.order) {
    if (entry.slot === undefined) {
      if (
        !preceding ||
        strongerStep(preceding.step, entry.step) !== preceding.step
      ) {
        preceding = entry;
      }
      continue;
    }
    const argument = argumentEffect(
      program,
      context.functionNode,
      call,
      entry.slot
    );
    if (preceding && !stepsCommute(preceding.step, argument)) {
      return `argument ${entry.slot + 1} at ${locationOf(call)} would be evaluated after ${preceding.node.getText()} instead of before it`;
    }
  }
  return null;
}
function argumentTexts(
  functionNode: HopCandidate["functionNode"],
  call: ts.CallExpression
) {
  const sourceFile = call.getSourceFile();
  return functionNode.parameters.map((parameter, index) => {
    if (parameter.dotDotDotToken) {
      return `[${call.arguments
        .slice(index)
        .map((argument) => argument.getText(sourceFile))
        .join(", ")}]`;
    }
    const argument = call.arguments[index];
    if (!argument) {
      return "undefined";
    }
    const text = argument.getText(sourceFile);
    return BARE_ARGUMENT_KINDS.has(argument.kind) ? text : `(${text})`;
  });
}
function siteHazard(
  functionNode: HopCandidate["functionNode"],
  call: ts.CallExpression
) {
  const hasRest = functionNode.parameters.some(
    (parameter) => parameter.dotDotDotToken
  );
  if (call.questionDotToken) {
    return "optional call";
  }
  if (call.typeArguments) {
    return "explicit type arguments";
  }
  if (call.arguments.some(ts.isSpreadElement)) {
    return "spread argument";
  }
  if (!hasRest && call.arguments.length > functionNode.parameters.length) {
    return "extra arguments would no longer be evaluated";
  }
  return null;
}
function calleeArgument(
  parameterUse: ParameterUse,
  argumentText: string,
  argument: ts.Expression | undefined
) {
  const use = outermostWrapper(parameterUse.node);
  const isCallee =
    ts.isCallExpression(use.parent) && use.parent.expression === use;
  const target = argument && unwrapped(argument);
  return isCallee &&
    target &&
    (ts.isPropertyAccessExpression(target) ||
      ts.isElementAccessExpression(target))
    ? `(0, ${argumentText})`
    : argumentText;
}
function inlinedText(
  body: ts.CallExpression,
  bindings: BodyBindings,
  call: ts.CallExpression,
  functionNode: HopCandidate["functionNode"]
) {
  const sourceFile = body.getSourceFile();
  const argumentTextsByParameter = argumentTexts(functionNode, call);
  const slots = [
    ...bindings.uses.map((use) => ({ ...use, parameter: true as const })),
    ...bindings.free.map((free) => ({ ...free, parameter: false as const })),
  ].sort((left, right) => left.node.getStart() - right.node.getStart());
  let text = "";
  let cursor = body.getStart(sourceFile);
  const offsets: InlineSite["offsets"][number][] = [];
  for (const slot of slots) {
    text += sourceFile.text.slice(cursor, slot.node.getStart(sourceFile));
    const prefix = slot.shorthand ? `${slot.node.text}: ` : "";
    if (slot.parameter) {
      text +=
        prefix +
        calleeArgument(
          slot,
          requireArgumentText(argumentTextsByParameter, slot.index),
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
function relocatedSpecifier(
  specifier: string,
  fromFile: string,
  toFile: string
) {
  if (!specifier.startsWith(".")) {
    return specifier;
  }
  const target = posix.join(posix.dirname(fromFile), specifier);
  const relocated = posix.relative(posix.dirname(toFile), target);
  return relocated.startsWith(".") ? relocated : `./${relocated}`;
}
function specifierStyle(specifier: string, fileName: string) {
  if (/\.[cm]?js$/u.test(specifier)) {
    return fileName.replace(/\.([cm]?)tsx?$/u, ".$1js");
  }
  if (/\.[cm]?tsx?$/u.test(specifier)) {
    return fileName;
  }
  return fileName.replace(/(?:\/index)?\.[cm]?tsx?$/u, "");
}
function specifierToFunctionFile(context: HopContext, siteFile: ts.SourceFile) {
  const { program, functionFile } = context;
  const direct = importOfFile(program, siteFile, functionFile);
  if (direct) {
    if (!ts.isStringLiteralLike(direct.moduleSpecifier)) {
      throw new TypeError("Hop import module is not a string");
    }
    return direct.moduleSpecifier.text;
  }
  const relativeImport = siteFile.statements.find(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteralLike(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text.startsWith(".")
  );
  const path = posix.relative(
    posix.dirname(siteFile.fileName),
    functionFile.fileName
  );
  return specifierStyle(
    relativeImport &&
      ts.isImportDeclaration(relativeImport) &&
      ts.isStringLiteralLike(relativeImport.moduleSpecifier)
      ? relativeImport.moduleSpecifier.text
      : "",
    path.startsWith(".") ? path : `./${path}`
  );
}
function importLine(
  context: HopContext,
  free: FreeBinding,
  siteFile: ts.SourceFile
) {
  const { origin, node } = free;
  const name = node.text;
  if (origin.kind === "module") {
    return `import { ${name} } from ${JSON.stringify(specifierToFunctionFile(context, siteFile))};`;
  }
  if (origin.kind === "global") {
    return null;
  }
  const declaration = origin.declaration;
  const importDeclaration = ts.findAncestor(
    declaration,
    ts.isImportDeclaration
  );
  if (!importDeclaration) {
    return null;
  }
  if (!ts.isStringLiteralLike(importDeclaration.moduleSpecifier)) {
    throw new TypeError("Import module is not a string");
  }
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
  const imported = ts.isImportSpecifier(declaration)
    ? (declaration.propertyName?.getText() ?? name)
    : name;
  return `import { ${imported === name ? name : `${imported} as ${name}`} } from ${specifier};`;
}
function exposeDependency(context: HopContext, origin: FreeBinding["origin"]) {
  if (
    origin.kind !== "module" ||
    ts.getCombinedModifierFlags(origin.declaration) & ts.ModifierFlags.Export
  ) {
    return;
  }
  const start = origin.statement.getStart(context.functionFile);
  context.edits.add(context.functionFile, start, start, "export ");
}
function siteImports(context: HopContext, site: ts.CallExpression) {
  const { program, bindings, functionFile, edits } = context;
  const siteFile = site.getSourceFile();
  if (siteFile === functionFile) {
    return null;
  }
  for (const free of bindings.free) {
    if (free.origin.kind === "local") {
      return `closes over local ${free.node.text}`;
    }
    const binding = bindingAtSite(program, free, site);
    if (binding === "other") {
      return `${free.node.text} names another binding at ${locationOf(site)}`;
    }
    if (binding === "same" || free.origin.kind === "global") {
      continue;
    }
    const line = importLine(context, free, siteFile);
    if (!line) {
      return `${free.node.text} comes from an import form that cannot move`;
    }
    edits.addImport(siteFile, line);
    exposeDependency(context, free.origin);
  }
  return null;
}
function planSites(context: HopContext) {
  const { functionNode, call, bindings, references, edits } = context;
  for (const { node: siteCall } of references.call) {
    const hazard =
      siteHazard(functionNode, siteCall) ??
      orderHazard(context.program, context, siteCall) ??
      siteImports(context, siteCall);
    if (hazard) {
      return hazard;
    }
    const inlined = inlinedText(call, bindings, siteCall, functionNode);
    const edit = edits.add(
      siteCall.getSourceFile(),
      siteCall.getStart(),
      siteCall.end,
      inlined.text
    );
    context.sites.push({ call: siteCall, edit, ...inlined });
  }
  for (const { node } of references.import) {
    removeImport(edits, node);
  }
  for (const { node } of references.export) {
    removeExport(edits, node);
  }
  removeDeclaration(edits, context.declaration);
  return null;
}
function verifyEdits(context: HopContext) {
  const hazard = planSites(context);
  if (hazard) {
    return rejected(hazard);
  }
  const files = orderedEdits(context.edits);
  if (!files) {
    return {
      hop: false,
      incomplete:
        "its call sites overlap, so the inline edits cannot be planned",
    };
  }
  const introduced = editedProgramHazard(context.program, files, context.sites);
  if (introduced) {
    return rejected(introduced);
  }
  if (context.incomplete) {
    return { hop: false, incomplete: context.incomplete };
  }
  return {
    hop: true,
    calls: context.sites.length,
    fix: new Map([...files].map(([fileName, { text }]) => [fileName, text])),
  };
}
export function verifyHop(program: ts.Program, candidate: HopCandidate) {
  const { declaration, functionNode, nameNode, call } = candidate;
  const contract = declaredContract(program, declaration, nameNode);
  if (contract) {
    return rejected(contract);
  }
  const references = programReferences(program, nameNode);
  const bindings = bodyBindings(program, functionNode, call);
  const exported = isExported(declaration, references);
  const surface = exported ? publicSurface(program, nameNode) : {};
  const owner = ownerReason(references, bindings, surface);
  if (owner) {
    return rejected(owner);
  }
  const { order, modelled } = bodyEvaluationOrder(program, functionNode);
  const hazard =
    bindings.hazards[0] ?? parameterHazard(functionNode, bindings.uses);
  if (hazard) {
    return rejected(hazard);
  }
  const unknown =
    bindings.unresolved[0] ??
    (modelled ? null : "the body's evaluation order is not modelled");
  if (unknown) {
    return { hop: false, incomplete: unknown };
  }
  return verifyEdits({
    program,
    declaration,
    functionNode,
    call,
    bindings,
    references,
    functionFile: nameNode.getSourceFile(),
    order,
    incomplete:
      surface.incomplete ??
      (exported && references.call.length === 0
        ? "it is exported and has no caller in this TypeScript program, so its consumers (other programs or loaders that resolve exports by name) are unknown"
        : undefined),
    edits: editSet(),
    sites: [],
  });
}
