import ts from "typescript";

import {
  isCallResultExpression,
  isThrowAssertionCallbackParse,
  isZodParseExpression,
  parsedCallResultMatchesSchemaOutput,
  recordParsedConst,
  zodParseCallParts,
} from "../../semantic-adapters/schema-provenance.mjs";
import {
  missingTypeServicesVisitors,
  requireTypeServices,
} from "./type-services.js";

const standardCollectionOwners = new Set(["Array", "ReadonlyArray"]);

function normalizedSourceFileName(declaration) {
  return declaration.getSourceFile().fileName.replace(/\\/gu, "/");
}

function isStandardCollectionMemberDeclaration(declaration) {
  const fileName = normalizedSourceFileName(declaration);
  return Boolean(
    fileName.includes("/typescript/lib/lib.") &&
    fileName.endsWith(".d.ts") &&
    ts.isMethodSignature(declaration) &&
    ts.isInterfaceDeclaration(declaration.parent) &&
    standardCollectionOwners.has(declaration.parent.name.text),
  );
}

function isRepoLocalDeclaration(declaration) {
  return !normalizedSourceFileName(declaration).includes("/node_modules/");
}

function resolvedCalleeSymbol(checker, tsCall) {
  const callee = tsCall.expression;
  const symbolNode = ts.isPropertyAccessExpression(callee)
    ? callee.name
    : callee;
  const symbol = checker.getSymbolAtLocation(symbolNode);
  return symbol && symbol.flags & ts.SymbolFlags.Alias
    ? checker.getAliasedSymbol(symbol)
    : symbol;
}

function hasRedundantParseOrigin(node, services, checker) {
  if (!isCallResultExpression(node)) {
    return false;
  }
  const call = node.type === "AwaitExpression" ? node.argument : node;
  const tsCall = services.esTreeNodeToTSNodeMap.get(call);
  if (!tsCall || !ts.isCallExpression(tsCall)) {
    return false;
  }
  const symbol = resolvedCalleeSymbol(checker, tsCall);
  return (symbol?.declarations ?? []).some(
    (declaration) =>
      isStandardCollectionMemberDeclaration(declaration) ||
      isRepoLocalDeclaration(declaration),
  );
}

export function ruleNoRedundantZodParse() {
  return {
    meta: {
      type: "problem",
      docs: {
        description:
          "Detect re-parsing a value with the same Zod schema that already produced it. Validate once at the boundary and pass the parsed value inward instead of re-validating in every layer.",
      },
      schema: [],
    },
    create(context) {
      const services = requireTypeServices(context);
      if (!services) {
        return missingTypeServicesVisitors(context, "no-redundant-zod-parse");
      }
      const checker = services.program.getTypeChecker();
      // Symbol of a value already validated → symbol of the schema that validated it.
      const validatedBy = new Map();
      const symbolOf = (node) => {
        const tsNode = services.esTreeNodeToTSNodeMap.get(node);
        return tsNode ? checker.getSymbolAtLocation(tsNode) : undefined;
      };
      const callResultSymbols = new Set();
      return {
        VariableDeclarator(node) {
          if (
            node.id.type !== "Identifier" ||
            !hasRedundantParseOrigin(node.init, services, checker)
          ) {
            return;
          }
          const sym = symbolOf(node.id);
          if (sym) {
            callResultSymbols.add(sym);
          }
        },
        CallExpression(node) {
          const parts = zodParseCallParts(node, services, checker);
          if (!parts) {
            return;
          }
          const { callee, tsCall, arg } = parts;
          const schemaSym =
            callee.object.type === "Identifier"
              ? symbolOf(callee.object)
              : undefined;
          if (isThrowAssertionCallbackParse(node)) {
            return;
          }
          // Re-parse: the argument is a value already validated by this exact schema (same binding).
          if (
            arg.type === "Identifier" &&
            schemaSym &&
            validatedBy.get(symbolOf(arg)) === schemaSym
          ) {
            context.report({
              node,
              message:
                "Redundant Zod parse: this value was already validated by the same schema. Validate once at the boundary and pass the parsed value inward instead of re-parsing.",
            });
            return;
          }
          // Service-to-boundary re-parse: a called helper/service already returned the schema's
          // output type, and the caller immediately validates that typed contract again.
          if (
            arg.type === "Identifier" &&
            callResultSymbols.has(symbolOf(arg)) &&
            parsedCallResultMatchesSchemaOutput(checker, services, tsCall, arg)
          ) {
            context.report({
              node,
              message:
                "Redundant Zod parse: this call result is already typed as the schema output. Validate once at the boundary and pass the parsed value inward instead of re-parsing.",
            });
            return;
          }
          if (
            isCallResultExpression(arg) &&
            hasRedundantParseOrigin(arg, services, checker) &&
            !isZodParseExpression(arg, services, checker) &&
            parsedCallResultMatchesSchemaOutput(checker, services, tsCall, arg)
          ) {
            context.report({
              node,
              message:
                "Redundant Zod parse: this call result is already typed as the schema output. Validate once at the boundary and pass the parsed value inward instead of re-parsing.",
            });
            return;
          }
          // Provenance: record `const v = Schema.parse(...)` / `const v = await Schema.parseAsync(...)`.
          recordParsedConst(node, schemaSym, symbolOf, validatedBy);
        },
      };
    },
  };
}
