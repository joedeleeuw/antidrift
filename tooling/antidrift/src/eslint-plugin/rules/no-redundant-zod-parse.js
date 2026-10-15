import ts from "typescript";

import { effectDecodeCallParts } from "../../semantic-adapters/effect-schema.mjs";
import {
  declaredSchemaParameter,
  isThrowAssertionCallbackParse,
  parsedSchemaSymbol,
  recordParsedConst,
  ZOD_VALIDATION_METHODS,
  zodParseCallParts,
} from "../../semantic-adapters/schema-provenance.mjs";
import {
  missingTypeServicesVisitors,
  requireTypeServices,
} from "./type-services.js";

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
    if (statement.expression.text === "use server") {
      return true;
    }
  }
  return false;
}

function moduleExportsFunction(checker, declaringFunction) {
  const moduleSymbol = checker.getSymbolAtLocation(
    declaringFunction.getSourceFile()
  );
  if (!moduleSymbol) {
    return false;
  }
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

function validationCallParts(node, services, checker) {
  const zodParts = zodParseCallParts(
    node,
    services,
    checker,
    ZOD_VALIDATION_METHODS
  );
  if (zodParts) {
    return { tsCall: zodParts.tsCall, arg: zodParts.arg };
  }
  const effectParts = effectDecodeCallParts(node, services, checker);
  if (!effectParts) {
    return null;
  }
  const tsCall = services.esTreeNodeToTSNodeMap.get(node);
  return tsCall ? { tsCall, arg: effectParts.valueArg } : null;
}

export function ruleNoRedundantZodParse() {
  return {
    meta: {
      type: "problem",
      docs: {
        description:
          "Detect re-parsing a value with the same schema that already produced it or that already types its parameter contract. Validate once at the boundary and pass the parsed value inward.",
      },
      schema: [],
    },
    create(context) {
      const services = requireTypeServices(context);
      if (!services) {
        return missingTypeServicesVisitors(context, "no-redundant-zod-parse");
      }
      const isTestFile = testFilenamePattern.test(context.filename ?? "");
      const checker = services.program.getTypeChecker();
      const validatedBy = new Map();
      const symbolOf = (node) => {
        const tsNode = services.esTreeNodeToTSNodeMap.get(node);
        return tsNode ? checker.getSymbolAtLocation(tsNode) : undefined;
      };
      return {
        CallExpression(node) {
          const parts = validationCallParts(node, services, checker);
          if (!parts || isThrowAssertionCallbackParse(node)) {
            return;
          }
          const { tsCall, arg } = parts;
          const schemaSym = parsedSchemaSymbol(checker, tsCall);
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
          if (!isTestFile && arg.type === "Identifier" && schemaSym) {
            const tsArg = services.esTreeNodeToTSNodeMap.get(arg);
            const parameter = tsArg && declaredSchemaParameter(checker, tsArg);
            if (
              parameter &&
              parameter.schema === schemaSym &&
              !isServerAction(checker, parameter.declaration)
            ) {
              context.report({
                node,
                message:
                  "Parse as cast: this parameter is typed as z.infer of the same schema, so the parse coerces a contract the caller already satisfied. Type the parameter as the unvalidated input and parse it once at the boundary, or trust the declared contract and drop the parse.",
              });
              return;
            }
          }
          recordParsedConst(node, schemaSym, symbolOf, validatedBy);
        },
      };
    },
  };
}
