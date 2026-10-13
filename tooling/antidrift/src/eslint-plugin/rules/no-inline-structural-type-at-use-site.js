import { relative, resolve } from "node:path";
import ts from "typescript";
import {
  declaresGenerated,
  packageDirectory,
  sameObjectShape,
} from "../../semantic-adapters/shape-identity.mjs";
import { inlineStructuralTypeAtBoundary } from "../../semantic-adapters/local-ast-rules.mjs";
import {
  missingTypeServicesVisitors,
  requireTypeServices,
} from "./type-services.js";

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

export function ruleNoInlineStructuralTypeAtUseSite() {
  return {
    meta: {
      type: "problem",
      docs: {
        description:
          "Require reuse when a boundary parameter repeats an existing object type.",
      },
      schema: [
        {
          type: "object",
          properties: {
            fixtureFiles: {
              type: "array",
              items: { type: "string" },
              uniqueItems: true,
            },
          },
          required: ["fixtureFiles"],
          additionalProperties: false,
        },
      ],
      messages: {
        named:
          "This parameter repeats {{name}} at {{location}}. Use that named type.",
        repeated:
          "This parameter repeats the inline type at {{location}}. Give the shared type one name and reuse it.",
      },
    },
    create(context) {
      const services = requireTypeServices(context);
      if (!services) {
        return missingTypeServicesVisitors(
          context,
          "no-inline-structural-type-at-use-site"
        );
      }
      const checker = services.program.getTypeChecker();
      const fixtureFiles = new Set(
        context.options
          .flatMap((options) => options.fixtureFiles)
          .map((filename) => resolve(context.cwd, filename))
      );
      return {
        TSTypeLiteral(node) {
          if (
            node.members.length < 3 ||
            !inlineStructuralTypeAtBoundary(node)
          ) {
            return;
          }
          const declaration = services.esTreeNodeToTSNodeMap.get(node);
          const type = checker.getTypeAtLocation(declaration);
          const key = propertyKey(type, checker);
          if (!key) return;
          const packageRoot = packageDirectory(
            declaration.getSourceFile().fileName
          );
          const candidates =
            programDeclarations(services.program).get(key) ?? [];
          const matches = candidates.filter(
            (candidate) =>
              candidate.node !== declaration &&
              !fixtureFiles.has(
                resolve(candidate.node.getSourceFile().fileName)
              ) &&
              (candidate.name ||
                (packageRoot !== null &&
                  candidate.packageRoot === packageRoot)) &&
              sameObjectShape(type, candidate.type, services.program)
          );
          const existing =
            matches.find((candidate) => candidate.name) ?? matches[0];
          if (!existing) return;
          const source = existing.node.getSourceFile();
          const line =
            source.getLineAndCharacterOfPosition(existing.node.getStart(source))
              .line + 1;
          context.report({
            node,
            messageId: existing.name ? "named" : "repeated",
            data: {
              name: existing.name,
              location: `${relative(context.cwd, source.fileName)}:${line}`,
            },
          });
        },
      };
    },
  };
}
