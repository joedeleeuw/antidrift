import ts from "typescript";

import { classifyInlineParseReshape } from "../../semantic-adapters/projection/inline-parse-reshape.ts";
import {
  declaredSchemaParameter,
  isThrowAssertionCallbackParse,
  parsedSchemaSymbol,
  recordParsedConst,
  schemaValidationCallParts,
} from "../../semantic-adapters/projection/schema-provenance.ts";
import { defineTypeScriptRule } from "../../semantic-adapters/kernel/rule-kernel.ts";

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

export function ruleNoRedundantZodParse() {
  return defineTypeScriptRule({
    ruleName: "no-redundant-zod-parse",
    skipGenerated: false,
    meta: {
      type: "problem",
      docs: {
        description:
          "Detect re-parsing a value with the same schema that already produced it, re-parsing a parameter typed by that schema, or reshaping a payload inline inside a schema parse call.",
      },
      messages: {
        inlineObjectReshape:
          "Do not reshape '{{source}}' inline inside a schema parse call (`parse({ ... })`). Pass the raw payload directly to a named boundary decoder built from the owner's contract shapes and parse once.",
        inlineConditionalReshape:
          "Do not conditionally reshape '{{source}}' inline inside a schema parse call (`parse(cond ? ... : ...)`). Define a named boundary decoder at the receiving adapter and parse once.",
      },
      schema: [],
    },
    visitors({ context, checker, services, filename }) {
      const isTestFile = testFilenamePattern.test(filename ?? "");
      const validatedBy = new Map();
      const symbolOf = (node) => {
        const tsNode = services.esTreeNodeToTSNodeMap.get(node);
        return tsNode ? checker.getSymbolAtLocation(tsNode) : undefined;
      };
      return {
        CallExpression(node) {
          const parts = schemaValidationCallParts(node, services, checker);
          if (!parts || isThrowAssertionCallbackParse(node)) {
            return;
          }
          const { tsCall, arg, schemaNode, returnsSchemaOutput } = parts;
          if (!isTestFile) {
            const tsArg = services.esTreeNodeToTSNodeMap.get(arg);
            const inlineReshape = classifyInlineParseReshape(tsArg, checker);
            if (inlineReshape) {
              context.report({
                node: arg,
                messageId: inlineReshape.messageId,
                data: inlineReshape.data,
              });
              return;
            }
          }
          const schemaSym = parsedSchemaSymbol(checker, tsCall, schemaNode);
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
          if (returnsSchemaOutput) {
            recordParsedConst(node, schemaSym, symbolOf, validatedBy);
          }
        },
      };
    },
  });
}
