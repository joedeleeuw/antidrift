import {
  inspectAppeasementCast,
  inspectImportSite,
} from "../../semantic-adapters/cast-proof.mjs";
import { defineTypeScriptRule } from "../../semantic-adapters/kernel/rule-kernel.ts";

export function ruleNoAppeasementCast() {
  return defineTypeScriptRule({
    ruleName: "no-appeasement-cast",
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow casting any/unknown values into contracts without proof.",
      },
      schema: [],
    },
    visitors({ context, checker, services }) {
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
  });
}
