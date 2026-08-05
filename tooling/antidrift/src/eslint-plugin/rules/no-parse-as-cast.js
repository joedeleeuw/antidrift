import {
  declaredSchemaSymbolOfParameter,
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
