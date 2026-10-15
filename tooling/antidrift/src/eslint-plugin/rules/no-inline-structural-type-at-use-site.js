import { relative, resolve } from "node:path";
import ts from "typescript";
import {
  declaresGenerated,
  packageDirectory,
  shapeComparison,
  unresolvedDescription,
} from "../../semantic-adapters/shape-identity.mjs";
import { inlineStructuralTypeAtBoundary } from "../../semantic-adapters/local-ast-rules.mjs";
import { defineTypeScriptRule } from "../../semantic-adapters/ts-rule-kernel.mjs";

const declarationsByProgram = new WeakMap();
const dependencySources = /(?:^|[/\\])node_modules(?:[/\\]|$)/u;

function propertyKey(type, checker) {
  const properties = checker.getPropertiesOfType(type);
  if (
    properties.length === 0 ||
    !(type.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection))
  ) {
    return null;
  }
  return JSON.stringify(properties.map((property) => property.name).sort());
}

function compiledDeclarations(program) {
  const configurations = [];
  const options = program.getCompilerOptions();
  if (options.configFilePath) {
    configurations.push({
      options,
      fileNames: program
        .getSourceFiles()
        .filter(
          (source) =>
            !source.isDeclarationFile &&
            !program.isSourceFileFromExternalLibrary(source)
        )
        .map((source) => source.fileName),
      errors: [],
    });
  }
  function collectReferences(references) {
    for (const reference of references) {
      if (!reference) continue;
      configurations.push(reference.commandLine);
      if (reference.references) collectReferences(reference.references);
    }
  }
  const references = program.getResolvedProjectReferences();
  if (references) collectReferences(references);
  const outputs = new Set();
  for (const configuration of configurations) {
    if (
      !configuration.options.declaration &&
      !configuration.options.composite
    ) {
      continue;
    }
    for (const filename of configuration.fileNames) {
      const source = program.getSourceFile(filename);
      if (!source || source.isDeclarationFile) continue;
      for (const output of ts.getOutputFileNames(
        configuration,
        filename,
        !ts.sys.useCaseSensitiveFileNames
      )) {
        if (/\.d\.[cm]?ts$/u.test(output)) outputs.add(resolve(output));
      }
    }
  }
  return new Set(
    program
      .getSourceFiles()
      .filter(
        (source) =>
          source.isDeclarationFile && outputs.has(resolve(source.fileName))
      )
  );
}

function referenceSymbol(node, checker) {
  if (ts.isShorthandPropertyAssignment(node)) {
    return checker.getShorthandAssignmentValueSymbol(node);
  }
  if (ts.isIdentifier(node)) {
    return checker.getSymbolAtLocation(node);
  }
  return undefined;
}

function derivesFrom(owner, declaration, checker) {
  const target = declaration.getSourceFile();
  const visited = new Set([owner]);
  const pending = [owner];
  while (pending.length > 0) {
    const node = pending.pop();
    const symbol = referenceSymbol(node, checker);
    const referenced =
      symbol && symbol.flags & ts.SymbolFlags.Alias
        ? checker.getAliasedSymbol(symbol)
        : symbol;
    for (const reference of referenced?.declarations ?? []) {
      if (
        reference.getSourceFile() === target &&
        !ts.isSourceFile(reference) &&
        !ts.isModuleDeclaration(reference) &&
        reference.pos <= declaration.pos &&
        declaration.end <= reference.end
      ) {
        return true;
      }
      if (
        reference.getSourceFile().isDeclarationFile ||
        visited.has(reference)
      ) {
        continue;
      }
      if (
        ts.isTypeAliasDeclaration(reference) ||
        ts.isInterfaceDeclaration(reference)
      ) {
        visited.add(reference);
        pending.push(reference);
      } else if (ts.isVariableDeclaration(reference)) {
        const typed = reference.type ?? reference.initializer;
        if (typed) {
          visited.add(reference);
          pending.push(typed);
        }
      }
    }
    ts.forEachChild(node, (child) => {
      if (!(ts.isFunctionLike(node) && child === node.body)) {
        pending.push(child);
      }
    });
  }
  return false;
}

function programDeclarations(program) {
  const cached = declarationsByProgram.get(program);
  if (cached) return cached;
  const checker = program.getTypeChecker();
  const declarations = new Map();
  const compiledCopies = compiledDeclarations(program);
  for (const source of program.getSourceFiles()) {
    if (
      program.isSourceFileDefaultLibrary(source) ||
      compiledCopies.has(source) ||
      dependencySources.test(source.fileName) ||
      declaresGenerated(source)
    ) {
      continue;
    }
    const packageRoot = packageDirectory(source.fileName);
    function visit(node) {
      const named =
        ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node);
      const inline =
        ts.isTypeLiteralNode(node) && !ts.isTypeAliasDeclaration(node.parent);
      if (named || inline) {
        const type = checker.getTypeAtLocation(node);
        const key = propertyKey(type, checker);
        if (key) {
          const bucket = declarations.get(key) ?? [];
          bucket.push({
            node,
            type,
            packageRoot,
            name: named ? node.name.text : null,
          });
          declarations.set(key, bucket);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  declarationsByProgram.set(program, declarations);
  return declarations;
}

function lineLocation(node, cwd) {
  const source = node.getSourceFile();
  const line =
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  return `${relative(cwd, source.fileName)}:${line}`;
}

function overriddenParameter(declaration, checker) {
  const parameter = declaration.parent;
  const member = parameter.parent;
  if (
    !ts.isParameter(parameter) ||
    parameter.type !== declaration ||
    !ts.isMethodDeclaration(member) ||
    !ts.isClassLike(member.parent) ||
    ts.getCombinedModifierFlags(member) & ts.ModifierFlags.Static
  ) {
    return null;
  }
  const memberName = checker.getSymbolAtLocation(member.name)?.name;
  const index = member.parameters.indexOf(parameter);
  const bases = [
    ...checker.getBaseTypes(checker.getTypeAtLocation(member.parent)),
    ...(ts.getEffectiveImplementsTypeNodes(member.parent) ?? []).map(
      (implemented) => checker.getTypeAtLocation(implemented)
    ),
  ];
  for (const base of bases) {
    const contract = memberName && checker.getPropertyOfType(base, memberName);
    const signatures = contract
      ? checker.getSignaturesOfType(
          checker.getTypeOfSymbolAtLocation(contract, member),
          ts.SignatureKind.Call
        )
      : [];
    const owned = signatures.length === 1 && signatures[0].parameters[index];
    if (owned?.valueDeclaration && contract.valueDeclaration) {
      return {
        node: owned.valueDeclaration.type ?? owned.valueDeclaration,
        type: checker.getTypeOfSymbolAtLocation(owned, member),
        name: `${contract.valueDeclaration.parent.name?.text ?? checker.typeToString(base)}.${memberName}`,
      };
    }
  }
  return null;
}

function exported(candidate, checker) {
  const source = candidate.node.getSourceFile();
  if (!ts.isExternalModule(source)) {
    return ts.isSourceFile(candidate.node.parent);
  }
  const moduleSymbol = checker.getSymbolAtLocation(source);
  const symbol = checker.getSymbolAtLocation(candidate.node.name);
  return checker
    .getExportsOfModule(moduleSymbol)
    .some(
      (exportedSymbol) =>
        (exportedSymbol.flags & ts.SymbolFlags.Alias
          ? checker.getAliasedSymbol(exportedSymbol)
          : exportedSymbol) === symbol
    );
}

function inScope(candidate, declaration) {
  const scope = candidate.node.parent;
  return (
    scope.getSourceFile() === declaration.getSourceFile() &&
    scope.pos <= declaration.pos &&
    declaration.end <= scope.end
  );
}

export function ruleNoInlineStructuralTypeAtUseSite() {
  return defineTypeScriptRule({
    ruleName: "no-inline-structural-type-at-use-site",
    meta: {
      type: "problem",
      docs: {
        description:
          "Require reuse when a boundary parameter repeats an existing object type.",
      },
      schema: [],
      messages: {
        overridden:
          "This parameter repeats the parameter of {{name}} at {{location}}, which this method overrides. Use that parameter's type.",
        named:
          "This parameter repeats {{name}} at {{location}}. Use that named type.",
        unscoped:
          "This parameter repeats {{name}} at {{location}}, which is not usable here. Export or move that type and reuse it.",
        repeated:
          "This parameter repeats the inline type at {{location}}. Give the shared type one name and reuse it.",
        undecided:
          "Whether this parameter repeats the type at {{location}} is undecided because {{unresolved}} does not resolve.",
      },
    },
    visitors({ context, checker, program, services, cwd }) {
      const sameShape = shapeComparison(program);
      return {
        TSTypeLiteral(node) {
          if (
            node.members.length < 3 ||
            !inlineStructuralTypeAtBoundary(node)
          ) {
            return;
          }
          const declaration = services.esTreeNodeToTSNodeMap.get(node);
          if (declaresGenerated(declaration.getSourceFile())) return;
          const type = checker.getTypeAtLocation(declaration);
          const key = propertyKey(type, checker);
          if (!key) return;
          const packageRoot = packageDirectory(
            declaration.getSourceFile().fileName
          );
          const candidates = programDeclarations(program).get(key) ?? [];
          const verdicts = candidates
            .filter(
              (candidate) =>
                candidate.node !== declaration &&
                (candidate.name ||
                  (packageRoot !== null &&
                    candidate.packageRoot === packageRoot))
            )
            .map((candidate) => ({
              candidate,
              verdict: sameShape(type, candidate.type),
            }))
            .filter(
              ({ candidate, verdict }) =>
                verdict !== false &&
                !derivesFrom(candidate.node, declaration, checker)
            );
          const governing = overriddenParameter(declaration, checker);
          if (
            governing &&
            sameShape(type, governing.type) === true &&
            !derivesFrom(governing.node, declaration, checker)
          ) {
            context.report({
              node,
              messageId: "overridden",
              data: {
                name: governing.name,
                location: lineLocation(governing.node, cwd),
              },
            });
            return;
          }
          const matches = verdicts
            .filter(({ verdict }) => verdict === true)
            .map(({ candidate }) => candidate);
          const named = matches.filter((candidate) => candidate.name);
          const usable = named.filter(
            (candidate) =>
              inScope(candidate, declaration) ||
              (candidate.node.getSourceFile() !== declaration.getSourceFile() &&
                exported(candidate, checker))
          );
          const existing = [
            ...usable.filter((candidate) => inScope(candidate, declaration)),
            ...usable.filter(
              (candidate) => candidate.packageRoot === packageRoot
            ),
            ...usable,
            ...named,
            ...matches,
          ][0];
          if (existing) {
            let messageId = "repeated";
            if (usable.includes(existing)) messageId = "named";
            else if (existing.name) messageId = "unscoped";
            context.report({
              node,
              messageId,
              data: {
                name: existing.name,
                location: lineLocation(existing.node, cwd),
              },
            });
            return;
          }
          const undecided = verdicts.find(
            ({ verdict }) => typeof verdict === "object"
          );
          if (undecided) {
            context.report({
              node,
              messageId: "undecided",
              data: {
                location: lineLocation(undecided.candidate.node, cwd),
                unresolved: unresolvedDescription(
                  undecided.verdict,
                  checker,
                  cwd
                ),
              },
            });
          }
        },
      };
    },
  });
}
