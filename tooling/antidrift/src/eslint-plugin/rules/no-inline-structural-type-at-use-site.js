import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { inlineStructuralTypeAtBoundary } from "../../semantic-adapters/local-ast-rules.mjs";
import {
  missingTypeServicesVisitors,
  requireTypeServices,
} from "./type-services.js";

const declarationsByProgram = new WeakMap();
const dependencySources = /(?:^|[/\\])node_modules(?:[/\\]|$)/u;

function packageDirectory(filename) {
  let directory = dirname(filename);
  while (!ts.sys.fileExists(join(directory, "package.json"))) {
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
  return directory;
}

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
      dependencySources.test(source.fileName)
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

function matchingTypes(type, ownedType, checker, compared) {
  if (type === ownedType) return true;
  const unchecked = ts.TypeFlags.Any | ts.TypeFlags.Unknown;
  if (
    (type.flags & unchecked) !== (ownedType.flags & unchecked) ||
    !checker.isTypeAssignableTo(type, ownedType) ||
    !checker.isTypeAssignableTo(ownedType, type)
  ) {
    return false;
  }
  if (compared.get(type)?.has(ownedType)) return true;
  const comparisons = new Map(compared);
  comparisons.set(type, new Set([...(compared.get(type) ?? []), ownedType]));
  if (type.isUnionOrIntersection() || ownedType.isUnionOrIntersection()) {
    if (type.flags !== ownedType.flags) return false;
    return (
      type.types.every((member) =>
        ownedType.types.some((ownedMember) =>
          matchingTypes(member, ownedMember, checker, comparisons)
        )
      ) &&
      ownedType.types.every((ownedMember) =>
        type.types.some((member) =>
          matchingTypes(member, ownedMember, checker, comparisons)
        )
      )
    );
  }
  if (checker.isArrayType(type) || checker.isTupleType(type)) {
    if (!checker.isArrayType(ownedType) && !checker.isTupleType(ownedType)) {
      return false;
    }
    const elements = checker.getTypeArguments(type);
    const ownedElements = checker.getTypeArguments(ownedType);
    return (
      elements.length === ownedElements.length &&
      elements.every((element, index) =>
        matchingTypes(element, ownedElements[index], checker, comparisons)
      )
    );
  }
  const propertiesMatch = checker
    .getPropertiesOfType(type)
    .every((property) => {
      const owned = checker.getPropertyOfType(ownedType, property.name);
      if (!owned) return true;
      return matchingTypes(
        checker.getTypeOfSymbol(property),
        checker.getTypeOfSymbol(owned),
        checker,
        comparisons
      );
    });
  if (!propertiesMatch) return false;
  const indexesMatch = checker.getIndexInfosOfType(type).every((index) => {
    const owned = checker
      .getIndexInfosOfType(ownedType)
      .find(
        (ownedIndex) =>
          checker.isTypeAssignableTo(index.keyType, ownedIndex.keyType) &&
          checker.isTypeAssignableTo(ownedIndex.keyType, index.keyType)
      );
    return (
      !owned || matchingTypes(index.type, owned.type, checker, comparisons)
    );
  });
  if (!indexesMatch) return false;
  return [ts.SignatureKind.Call, ts.SignatureKind.Construct].every((kind) => {
    const signatures = checker.getSignaturesOfType(type, kind);
    const ownedSignatures = checker.getSignaturesOfType(ownedType, kind);
    return signatures.every((signature, index) => {
      const owned = ownedSignatures[index];
      if (!owned) return false;
      return (
        matchingTypes(
          checker.getReturnTypeOfSignature(signature),
          checker.getReturnTypeOfSignature(owned),
          checker,
          comparisons
        ) &&
        signature.parameters.every((parameter, parameterIndex) => {
          const ownedParameter = owned.parameters[parameterIndex];
          return Boolean(
            ownedParameter &&
            matchingTypes(
              checker.getTypeOfSymbol(parameter),
              checker.getTypeOfSymbol(ownedParameter),
              checker,
              comparisons
            )
          );
        })
      );
    });
  });
}

function matchingProperties(candidate, type, checker) {
  return (
    matchingTypes(type, candidate.type, checker, new Map()) &&
    checker.getPropertiesOfType(type).every((property) => {
      const owned = checker.getPropertyOfType(candidate.type, property.name);
      return (
        owned &&
        (property.flags & ts.SymbolFlags.Optional) ===
          (owned.flags & ts.SymbolFlags.Optional)
      );
    })
  );
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
          if (!inlineStructuralTypeAtBoundary(node)) return;
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
              matchingProperties(candidate, type, checker)
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
