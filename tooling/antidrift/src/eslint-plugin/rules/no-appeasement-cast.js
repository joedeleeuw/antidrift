import {
  inspectAppeasementCast,
  inspectImportSite,
} from "../../semantic-adapters/cast-proof.mjs";
import { isDeclaredGeneratedSource } from "../../semantic-adapters/generated-source.mjs";
import {
  missingTypeServicesVisitors,
  requireTypeServices,
} from "../../semantic-adapters/ts-rule-kernel.mjs";

export function ruleNoAppeasementCast() {
  return {
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow casting any/unknown values into contracts without proof.",
      },
      schema: [],
    },
    create(context) {
      if (isDeclaredGeneratedSource(context.sourceCode.text)) {
        return {};
      }
      const services = requireTypeServices(context);
      if (!services) {
        return missingTypeServicesVisitors(context, "no-appeasement-cast");
      }
      const checker = services.program.getTypeChecker();
      function reportCast(node) {
        const decision = inspectAppeasementCast(node, services, checker);
        if (decision.action !== "clear") {
          context.report({ node, message: decision.message });
        }
      }
      function reportImportSite(node) {
        const message = inspectImportSite(node, services, checker);
        if (message) {
          context.report({ node, message });
        }
      }
      return {
        TSAsExpression: reportCast,
        TSTypeAssertion: reportCast,
        ImportDeclaration: reportImportSite,
        ExportAllDeclaration: reportImportSite,
        "ExportNamedDeclaration[source]": reportImportSite,
        ImportExpression: reportImportSite,
        TSExternalModuleReference: reportImportSite,
        TSImportType: reportImportSite,
      };
    },
  };
}
