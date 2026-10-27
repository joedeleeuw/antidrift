import ts from "typescript";

import { scopeProperties } from "../../semantic-adapters/kernel/rule-scope.ts";
import { isTestFilename } from "../../oxlint-plugin/portable/syntax.js";
import { defineTypeScriptRule } from "../../semantic-adapters/kernel/rule-kernel.ts";
import {
  isLayerConstructionCall,
  serviceContractProvenance,
} from "../../semantic-adapters/boundary/service-contract.ts";
import {
  resolveAliasedSymbol,
  resolveImportedModuleSourceFile,
} from "../../semantic-adapters/provenance/symbol-provenance.ts";

function isInsideLayerConstruction(node, stopNode) {
  let current = node.parent;
  while (current && current !== stopNode) {
    if (ts.isCallExpression(current) && isLayerConstructionCall(current)) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function isOnlyUsedInLayerConstruction(
  checker,
  sourceFile,
  importDeclaration,
  localIdentifier
) {
  const localSymbol = checker.getSymbolAtLocation(localIdentifier);
  if (!localSymbol) {
    return false;
  }
  let referenceCount = 0;
  let allInsideLayer = true;
  function visit(currentNode) {
    if (!allInsideLayer || currentNode === importDeclaration) {
      return;
    }
    if (
      ts.isIdentifier(currentNode) &&
      checker.getSymbolAtLocation(currentNode) === localSymbol
    ) {
      referenceCount += 1;
      if (!isInsideLayerConstruction(currentNode, sourceFile)) {
        allInsideLayer = false;
        return;
      }
    }
    ts.forEachChild(currentNode, visit);
  }
  visit(sourceFile);
  return referenceCount > 0 && allInsideLayer;
}

function collectImportBindings(importClause) {
  const bindings = [];
  if (!importClause || importClause.isTypeOnly) {
    return bindings;
  }
  if (importClause.name) {
    bindings.push({
      reportTarget: importClause.name,
      localIdentifier: importClause.name,
    });
  }
  const namedBindings = importClause.namedBindings;
  if (namedBindings && ts.isNamedImports(namedBindings)) {
    for (const element of namedBindings.elements) {
      if (!element.isTypeOnly) {
        bindings.push({
          reportTarget: element,
          localIdentifier: element.name,
        });
      }
    }
  }
  return bindings;
}

export function ruleNoServiceConstructorImports() {
  return defineTypeScriptRule({
    ruleName: "no-service-constructor-imports",
    skipNonRuleFile: true,
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow importing raw service constructors from modules that own an Effect service tag or layer unless wiring a layer.",
      },
      schema: [
        {
          type: "object",
          properties: scopeProperties,
          additionalProperties: false,
        },
      ],
      messages: {
        serviceConstructorImport:
          "Import the service tag or Layer from '{{moduleSpecifier}}' instead of its raw constructor '{{importedName}}'; resolve the service through the Effect context or wire '{{importedName}}' inside a Layer.",
      },
    },
    run({ sourceFile, checker, program, filename, reportNode }) {
      if (isTestFilename(filename)) {
        return {};
      }
      return {
        [ts.SyntaxKind.ImportDeclaration](importDeclaration) {
          const targetSourceFile = resolveImportedModuleSourceFile(
            checker,
            importDeclaration
          );
          if (
            !targetSourceFile ||
            targetSourceFile.isDeclarationFile ||
            program.isSourceFileFromExternalLibrary(targetSourceFile) ||
            program.isSourceFileDefaultLibrary(targetSourceFile)
          ) {
            return;
          }
          const provenance = serviceContractProvenance(
            program,
            targetSourceFile
          );
          if (
            !provenance.hasServiceContract ||
            provenance.constructorSymbols.size === 0
          ) {
            return;
          }
          const bindings = collectImportBindings(
            importDeclaration.importClause
          );
          for (const { reportTarget, localIdentifier } of bindings) {
            const targetSymbol = resolveAliasedSymbol(
              checker,
              checker.getSymbolAtLocation(localIdentifier)
            );
            if (
              !targetSymbol ||
              !provenance.constructorSymbols.has(targetSymbol) ||
              isOnlyUsedInLayerConstruction(
                checker,
                sourceFile,
                importDeclaration,
                localIdentifier
              )
            ) {
              continue;
            }
            reportNode(reportTarget, {
              messageId: "serviceConstructorImport",
              data: {
                importedName: localIdentifier.text,
                moduleSpecifier: importDeclaration.moduleSpecifier.text,
              },
            });
          }
        },
      };
    },
  });
}
