import { defineTypeScriptRule } from "../../semantic-adapters/kernel/rule-kernel.ts";
import { createFieldBlockVisitors } from "./structural-type-fork/field-block-analysis.js";
import { StructuralRuleSession } from "./structural-type-fork/analysis-session.ts";

export function ruleNoStructuralTypeFork() {
  const typedRule = defineTypeScriptRule({
    ruleName: "no-structural-type-fork",
    skipGenerated: false,
    meta: {
      type: "problem",
      docs: {
        description:
          "Detect hand-written types and schema field blocks that duplicate an owned contract instead of importing or deriving it.",
      },
      messages: {
        structuralTypeFork:
          "Type matches {{owner}} — import or derive from the owner instead of redeclaring.",
        ownedContractProjection:
          "Contract copies {{owner}} through a proven owner use — import or derive the projection instead of redeclaring.",
        sharedContractOwner:
          "Type matches {{owner}}, but that package depends on this package. Move the shared contract to a package both can import.",
        duplicatedObjectFieldBlocks:
          "{{shapes}} object shapes repeat the same {{count}} fields ({{fields}}). Hoist the shared field block into one named shape and spread or extend it instead of repeating it.",
        redundantLocalReturnType:
          "This nested implementation's explicit return type repeats its inferred shorthand-object shape, and every call is constrained by the enclosing function's return contract. Remove the local annotation and keep the named type at that owner.",
        overridden:
          "This parameter repeats the parameter of {{name}} at {{location}}, which this method overrides. Use that parameter's type.",
        named:
          "This parameter repeats {{name}} at {{location}}. Use that named type.",
        unscoped:
          "This parameter repeats {{name}} at {{location}}, which is not usable here. Export or move that type and reuse it.",
        repeated:
          "This parameter repeats the inline type at {{location}}. Give the shared type one name and reuse it.",
        undecided:
          "Whether this parameter repeats the type at {{location}} is undecided because {{unresolved}} does not resolve.",
      },
      schema: [
        {
          type: "object",
          additionalProperties: false,
          properties: {
            generatedSources: {
              type: "object",
              additionalProperties: {
                type: "object",
                additionalProperties: true,
                properties: {
                  generated: { type: "string" },
                },
              },
            },
            packageTypeOwners: {
              type: "object",
              additionalProperties: {
                type: "object",
                required: ["package", "exportName"],
                additionalProperties: false,
                properties: {
                  package: { type: "string" },
                  exportName: { type: "string" },
                  reason: { type: "string" },
                },
              },
            },
            canonicalEntities: {
              type: "object",
              additionalProperties: {
                oneOf: [
                  { type: "string" },
                  {
                    type: "object",
                    additionalProperties: true,
                    properties: {
                      owner: { type: "string" },
                      exportName: { type: "string" },
                    },
                  },
                ],
              },
            },
            fieldBlocks: {
              type: "object",
              additionalProperties: false,
              properties: {
                minSharedFields: { type: "integer", minimum: 1 },
                minShapes: { type: "integer", minimum: 2 },
                minRedundantDeclarations: { type: "integer", minimum: 1 },
              },
            },
          },
        },
      ],
    },
    visitors: StructuralRuleSession.visitors,
  });
  return {
    meta: typedRule.meta,
    create(context) {
      if (/\.[cm]?jsx?$/u.test(context.filename)) {
        return createFieldBlockVisitors(
          context,
          context.options[0]?.fieldBlocks
        );
      }
      return typedRule.create(context);
    },
  };
}
