import ts from "typescript";

import {
  isThrowAssertionCallbackParse,
  ZOD_VALIDATION_METHODS,
  zodParseCallParts,
} from "../../semantic-adapters/schema-provenance.mjs";
import {
  missingTypeServicesVisitors,
  requireTypeServices,
} from "./type-services.js";

const SCHEMA_OUTPUT_TYPE_NAMES = new Set(["infer", "output", "TypeOf"]);

function resolvedSymbol(checker, symbol) {
  return symbol && symbol.flags & ts.SymbolFlags.Alias
    ? checker.getAliasedSymbol(symbol)
    : symbol;
}

function symbolForExpression(checker, expression) {
  const node = ts.isPropertyAccessExpression(expression)
    ? expression.name
    : expression;
  const symbol = resolvedSymbol(checker, checker.getSymbolAtLocation(node));
  const declaration = symbol?.valueDeclaration;
  if (
    declaration &&
    ts.isPropertyAssignment(declaration) &&
    ts.isIdentifier(declaration.initializer)
  ) {
    return resolvedSymbol(
      checker,
      checker.getSymbolAtLocation(declaration.initializer),
    );
  }
  return symbol;
}

function parsedSchemaSymbol(checker, tsCall) {
  const callee = tsCall.expression;
  if (!ts.isPropertyAccessExpression(callee)) {
    return undefined;
  }
  return symbolForExpression(checker, callee.expression);
}

// `z.infer<typeof S>` / `z.output<typeof S>` — the schema the alias was derived from.
function schemaSymbolOfOutputAlias(checker, typeNode) {
  if (!typeNode || !ts.isTypeReferenceNode(typeNode)) {
    return undefined;
  }
  const name = typeNode.typeName;
  const memberName = ts.isQualifiedName(name) ? name.right.text : name.text;
  if (!SCHEMA_OUTPUT_TYPE_NAMES.has(memberName)) {
    return undefined;
  }
  const [argument] = typeNode.typeArguments ?? [];
  if (!argument || !ts.isTypeQueryNode(argument)) {
    return undefined;
  }
  const reference = ts.isQualifiedName(argument.exprName)
    ? argument.exprName.right
    : argument.exprName;
  return resolvedSymbol(checker, checker.getSymbolAtLocation(reference));
}

function aliasDeclarationOfTypeNode(checker, typeNode) {
  if (!typeNode || !ts.isTypeReferenceNode(typeNode)) {
    return undefined;
  }
  const reference = ts.isQualifiedName(typeNode.typeName)
    ? typeNode.typeName.right
    : typeNode.typeName;
  const symbol = resolvedSymbol(checker, checker.getSymbolAtLocation(reference));
  return (symbol?.declarations ?? []).find((declaration) =>
    ts.isTypeAliasDeclaration(declaration),
  );
}

function declaredSchemaSymbolOfParameter(checker, tsArg) {
  const symbol = checker.getSymbolAtLocation(tsArg);
  const parameter = (symbol?.declarations ?? []).find(
    (declaration) => ts.isParameter(declaration) && declaration.type,
  );
  if (!parameter) {
    return undefined;
  }
  const alias = aliasDeclarationOfTypeNode(checker, parameter.type);
  return alias && schemaSymbolOfOutputAlias(checker, alias.type);
}

export function ruleNoParseAsCast() {
  return {
    meta: {
      type: "problem",
      docs: {
        description:
          "Detect parsing a parameter whose declared type was derived from the same schema with z.infer. The caller's contract is the schema's own output, so the parse coerces a value the compiler already proved instead of validating an untrusted one.",
      },
      schema: [],
    },
    create(context) {
      const services = requireTypeServices(context);
      if (!services) {
        return missingTypeServicesVisitors(context, "no-parse-as-cast");
      }
      const checker = services.program.getTypeChecker();
      return {
        CallExpression(node) {
          const parts = zodParseCallParts(
            node,
            services,
            checker,
            ZOD_VALIDATION_METHODS,
          );
          if (!parts || isThrowAssertionCallbackParse(node)) {
            return;
          }
          const { tsCall, arg } = parts;
          if (arg.type !== "Identifier") {
            return;
          }
          const tsArg = services.esTreeNodeToTSNodeMap.get(arg);
          const declaredSchema =
            tsArg && declaredSchemaSymbolOfParameter(checker, tsArg);
          if (
            !declaredSchema ||
            declaredSchema !== parsedSchemaSymbol(checker, tsCall)
          ) {
            return;
          }
          context.report({
            node,
            message:
              "Parse as cast: this parameter is typed as z.infer of the same schema, so the parse coerces a contract the caller already satisfied. Type the parameter as the unvalidated input and parse it once at the boundary, or trust the declared contract and drop the parse.",
          });
        },
      };
    },
  };
}
