import { dirname, join, relative } from "node:path";
import ts from "typescript";
import {
  declaredDependencies,
  dependencyManifest,
  governingOptions,
  importedName,
  manifestDependencyFields,
  resolvedModule,
  resolvesToTypes,
  scriptSpecifier,
  specifierPackage,
  unresolvedEntries,
} from "../../semantic-adapters/declared-dependencies.mjs";
import { packageDirectory } from "../../semantic-adapters/shape-identity.mjs";
import {
  missingTypeServicesVisitors,
  requireTypeServices,
} from "./type-services.js";

const scopesByProgram = new WeakMap();

function moduleSpecifiers(node, specifiers = []) {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier &&
    ts.isStringLiteral(node.moduleSpecifier)
  ) {
    specifiers.push(node.moduleSpecifier);
  } else if (
    ts.isExternalModuleReference(node) &&
    ts.isStringLiteral(node.expression)
  ) {
    specifiers.push(node.expression);
  } else if (
    ts.isCallExpression(node) &&
    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) &&
        node.expression.text === "require")) &&
    node.arguments[0] &&
    ts.isStringLiteralLike(node.arguments[0])
  ) {
    specifiers.push(node.arguments[0]);
  } else if (
    ts.isImportTypeNode(node) &&
    ts.isLiteralTypeNode(node.argument) &&
    ts.isStringLiteral(node.argument.literal)
  ) {
    specifiers.push(node.argument.literal);
  }
  ts.forEachChild(node, (child) => {
    moduleSpecifiers(child, specifiers);
  });
  return specifiers;
}

function dependencyNames(packageNames) {
  return new Map(
    packageNames.flatMap((packageName) => [
      [packageName, packageName],
      [importedName(packageName), packageName],
    ])
  );
}

function dependencyScope(program, packageRoot) {
  const scopes = scopesByProgram.get(program) ?? new Map();
  scopesByProgram.set(program, scopes);
  if (!scopes.has(packageRoot)) {
    const options = program.getCompilerOptions();
    const missing = [];
    const installed = [];
    for (const dependency of declaredDependencies(packageRoot)) {
      (dependencyManifest(packageRoot, dependency, options)
        ? installed
        : missing
      ).push(dependency);
    }
    scopes.set(packageRoot, {
      missingByName: dependencyNames(missing),
      installedByName: dependencyNames(installed),
    });
  }
  return scopes.get(packageRoot);
}

function moduleResolves(specifier, source, program) {
  const holder = specifier.parent;
  const lookup = [
    specifier.text,
    source.fileName,
    program.getCompilerOptions(),
    source.impliedNodeFormat,
  ];
  if (ts.isImportDeclaration(holder) && !holder.importClause) {
    return Boolean(resolvedModule(...lookup));
  }
  if (
    ts.isCallExpression(holder) &&
    ts.isIdentifier(holder.expression) &&
    holder.expression.text === "require" &&
    !ts.isInJSFile(holder)
  ) {
    return resolvesToTypes(...lookup);
  }
  return Boolean(program.getTypeChecker().getSymbolAtLocation(specifier));
}

function manifestVisitors(context) {
  const packageRoot = dirname(context.filename);
  const options = governingOptions(packageRoot);
  return {
    Document(node) {
      if (node.body.type !== "Object") return;
      const keys = new Map();
      for (const fieldName of manifestDependencyFields) {
        const field = node.body.members.find(
          (member) => member.name.value === fieldName
        );
        if (field?.value.type !== "Object") continue;
        for (const member of field.value.members) {
          if (!keys.has(member.name.value)) {
            keys.set(member.name.value, member.name);
          }
        }
      }
      for (const [packageName, key] of keys) {
        const manifestPath = dependencyManifest(
          packageRoot,
          packageName,
          options
        );
        if (!manifestPath) {
          context.report({
            node: key,
            messageId: "uninstalledManifest",
            data: { packageName },
          });
          continue;
        }
        const entries = unresolvedEntries(
          packageRoot,
          packageName,
          manifestPath,
          options
        );
        if (entries.length > 0) {
          context.report({
            node: key,
            messageId: "unresolvedEntry",
            data: { packageName, entries: entries.join(", ") },
          });
        }
      }
    },
  };
}

export function ruleNoUnresolvedDependencyTypes() {
  return {
    meta: {
      type: "problem",
      docs: {
        description:
          "Report declared dependencies and imports whose type declarations do not resolve, because their exported types cannot be compared with first-party types.",
      },
      schema: [],
      messages: {
        uninstalledImport:
          "{{packageName}} is declared in {{manifest}} but not installed, so its exported types are not compared with first-party types.",
        unresolvedImport:
          "{{packageName}} is installed but '{{specifier}}' does not resolve to type declarations, so its exported types are not compared with first-party types.",
        uninstalledManifest:
          "{{packageName}} is declared here but not installed, so its exported types are not compared with first-party types in this package.",
        unresolvedEntry:
          "{{packageName}} is a workspace or linked package whose public entries {{entries}} do not resolve to type declarations, so their exported types are not compared with first-party types in this package.",
      },
    },
    create(context) {
      if (context.sourceCode.ast.type === "Document") {
        return manifestVisitors(context);
      }
      const services = requireTypeServices(context);
      if (!services) {
        return missingTypeServicesVisitors(
          context,
          "no-unresolved-dependency-types"
        );
      }
      return {
        Program() {
          const { program } = services;
          const source = program.getSourceFile(context.filename);
          const packageRoot = source && packageDirectory(source.fileName);
          if (!packageRoot) return;
          const scope = dependencyScope(program, packageRoot);
          const manifest = relative(
            context.cwd,
            join(packageRoot, "package.json")
          );
          for (const specifier of moduleSpecifiers(source)) {
            const imported = specifierPackage(specifier.text);
            const missing = scope.missingByName.get(imported);
            const installed = scope.installedByName.get(imported);
            let report = null;
            if (missing) {
              report = {
                messageId: "uninstalledImport",
                data: { packageName: missing, manifest },
              };
            } else if (
              installed &&
              scriptSpecifier(specifier.text, imported) &&
              !moduleResolves(specifier, source, program)
            ) {
              report = {
                messageId: "unresolvedImport",
                data: { packageName: installed, specifier: specifier.text },
              };
            }
            if (!report) continue;
            const start = source.getLineAndCharacterOfPosition(
              specifier.getStart(source)
            );
            const end = source.getLineAndCharacterOfPosition(specifier.end);
            context.report({
              loc: {
                start: { line: start.line + 1, column: start.character },
                end: { line: end.line + 1, column: end.character },
              },
              ...report,
            });
          }
        },
      };
    },
  };
}
