import ts from "typescript";

import {
  declaredSchemaParameter,
  isThrowAssertionCallbackParse,
  parsedSchemaSymbol,
  ZOD_VALIDATION_METHODS,
  zodParseCallParts,
} from "../../semantic-adapters/schema-provenance.mjs";
import {
  missingTypeServicesVisitors,
  requireTypeServices,
} from "./type-services.js";

// Test files assert contracts on purpose: a bare parse of a typed value is a
// schema-conformance oracle there, not a coerced boundary.
const testFilenamePattern =
  /(?:(?:^|[/\\])(?:test|tests|__tests__)(?:[/\\])|[.](?:test|spec)[.][cm]?[jt]sx?$)/u;

function hasUseServerDirective(statements) {
  for (const statement of statements ?? []) {
    if (
      !ts.isExpressionStatement(statement) ||
      !ts.isStringLiteral(statement.expression)
    ) {
      return false;
    }
    if (statement.expression.text === "use server") return true;
  }
  return false;
}

function moduleExportsFunction(checker, declaringFunction) {
  const moduleSymbol = checker.getSymbolAtLocation(
    declaringFunction.getSourceFile()
  );
  if (!moduleSymbol) return false;
  const declaration = ts.isVariableDeclaration(declaringFunction.parent)
    ? declaringFunction.parent
    : declaringFunction;
  return checker.getExportsOfModule(moduleSymbol).some((exported) => {
    const target =
      exported.flags & ts.SymbolFlags.Alias
        ? checker.getAliasedSymbol(exported)
        : exported;
    return (target.declarations ?? []).includes(declaration);
  });
}

// A Next.js server action is a network endpoint: the client can send any value,
// so parsing its declared input decodes an untrusted boundary instead of
// coercing a contract the caller already satisfied.
function isServerAction(checker, parameter) {
  const declaringFunction = parameter.parent;
  const body = declaringFunction.body;
  if (body && ts.isBlock(body) && hasUseServerDirective(body.statements)) {
    return true;
  }
  return (
    hasUseServerDirective(declaringFunction.getSourceFile().statements) &&
    moduleExportsFunction(checker, declaringFunction)
  );
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
      if (testFilenamePattern.test(context.filename)) {
        return {};
      }
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
            ZOD_VALIDATION_METHODS
          );
          if (!parts || isThrowAssertionCallbackParse(node)) {
            return;
          }
          const { tsCall, arg } = parts;
          if (arg.type !== "Identifier") {
            return;
          }
          const tsArg = services.esTreeNodeToTSNodeMap.get(arg);
          const parameter = tsArg && declaredSchemaParameter(checker, tsArg);
          if (
            !parameter ||
            parameter.schema !== parsedSchemaSymbol(checker, tsCall) ||
            isServerAction(checker, parameter.declaration)
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
