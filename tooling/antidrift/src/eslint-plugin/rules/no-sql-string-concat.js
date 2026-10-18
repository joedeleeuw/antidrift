import {
  safeIdentifierMemberSpecs,
  safeTemplateTagSpecs,
} from "../../semantic-adapters/sql.mjs";
import { createSqlProvenanceTracker } from "../../semantic-adapters/sql-provenance.mjs";
import {
  containsSqlStatement,
  SQL_PREFIX_PATTERN,
  templateText,
} from "../../semantic-adapters/sql-syntax-analysis.mjs";
import { requireTypeServices } from "../../semantic-adapters/kernel/rule-kernel.ts";

export function ruleNoSqlStringConcat() {
  return {
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow SQL assembled via string interpolation or concatenation.",
      },
      schema: [
        {
          type: "object",
          properties: {
            safeIdentifierMembers: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  type: { type: "string" },
                  member: { type: "string" },
                  evidence: { type: "string" },
                },
                required: ["type", "member"],
                additionalProperties: false,
              },
            },
            safeTemplateTags: {
              type: "array",
              items: {
                type: "object",
                oneOf: [
                  {
                    properties: {
                      module: { type: "string" },
                      export: { type: "string" },
                      evidence: { type: "string" },
                    },
                    required: ["module", "export"],
                    additionalProperties: false,
                  },
                  {
                    properties: {
                      type: { type: "string" },
                      member: { type: "string" },
                      source: { type: "string", pattern: String.raw`[/\\]` },
                      evidence: { type: "string" },
                    },
                    required: ["type", "member", "source"],
                    additionalProperties: false,
                  },
                ],
              },
            },
          },
          additionalProperties: false,
        },
      ],
    },
    create(context) {
      const sourceCode = context.sourceCode;
      const safeIdentifierMembers = safeIdentifierMemberSpecs(
        context.options[0] ?? {}
      );
      const safeTemplateTags = safeTemplateTagSpecs(context.options[0] ?? {});
      const services = requireTypeServices(context);
      const checker = services?.program?.getTypeChecker() ?? null;
      const provenance = createSqlProvenanceTracker({
        sourceCode,
        safeIdentifierMembers,
        safeTemplateTags,
        services,
        checker,
      });

      return {
        Program(node) {
          provenance.scanProgram(node);
        },
        VariableDeclarator(node) {
          provenance.trackVariableDeclarator(node);
        },
        AssignmentExpression(node) {
          provenance.trackAssignment(node);
        },
        IfStatement(node) {
          provenance.trackIfStatement(node);
        },
        "AssignmentExpression:exit"(node) {
          provenance.trackMemberAssignmentExit(node);
        },
        CallExpression(node) {
          provenance.trackCallExpression(node);
        },
        TaggedTemplateExpression(node) {
          if (provenance.isTrustedSqlTemplateTag(node.tag)) {
            for (const expression of provenance.unsafeTrustedRawSqlFragments(
              node.quasi
            )) {
              context.report({
                node: expression,
                message:
                  "Do not pass dynamic values through raw SQL builder fragments. Use bound parameters or a proven identifier escape.",
              });
            }
            return;
          }
          if (
            node.quasi.expressions.length > 0 &&
            containsSqlStatement(templateText(node.quasi)) &&
            provenance.hasUnsafeSqlInterpolation(node.quasi)
          ) {
            context.report({
              node: node.quasi,
              message:
                "Do not interpolate values into SQL strings. Use parameterized queries / bound parameters.",
            });
          }
        },
        TemplateLiteral(node) {
          if (
            node.parent?.type === "TaggedTemplateExpression" &&
            node.parent.quasi === node
          ) {
            return;
          }
          if (
            node.expressions.length > 0 &&
            containsSqlStatement(templateText(node)) &&
            provenance.hasUnsafeSqlInterpolation(node)
          ) {
            context.report({
              node,
              message:
                "Do not interpolate values into SQL strings. Use parameterized queries / bound parameters.",
            });
          }
        },
        BinaryExpression(node) {
          if (node.operator !== "+") {
            return;
          }
          const sides = [node.left, node.right];
          const hasSqlLiteral = sides.some(
            (side) =>
              side?.type === "Literal" &&
              typeof side.value === "string" &&
              SQL_PREFIX_PATTERN.test(side.value)
          );
          const hasNonLiteral = sides.some(
            (side) => side && side.type !== "Literal"
          );
          if (hasSqlLiteral && hasNonLiteral) {
            context.report({
              node,
              message:
                "Do not concatenate values into SQL strings. Use parameterized queries / bound parameters.",
            });
          }
        },
      };
    },
  };
}
