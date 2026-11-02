import { isRuleFile, scopeProperties } from "../shared/rule-scope.js";
import { unwrapExpression } from "../shared/scope.js";

export const noContractAppeasementProjectionRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow `{ ok, data, error }` product result envelopes and verbatim 3+ property bag clones `{ a: x.a, b: x.b, c: x.c }`.",
    },
    schema: [
      {
        type: "object",
        properties: scopeProperties,
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    return {
      ObjectExpression(node) {
        if (node.properties.length < 3) return;
        let sourceIdent = null;
        let allSameSource = true;
        for (const prop of node.properties) {
          if (
            prop.type !== "Property" ||
            prop.computed ||
            prop.shorthand ||
            prop.key?.type !== "Identifier"
          ) {
            allSameSource = false;
            break;
          }
          const val = unwrapExpression(prop.value);
          if (
            val?.type !== "MemberExpression" ||
            val.computed ||
            val.object?.type !== "Identifier" ||
            val.property?.type !== "Identifier" ||
            val.property.name !== prop.key.name
          ) {
            allSameSource = false;
            break;
          }
          if (sourceIdent === null) {
            sourceIdent = val.object.name;
          } else if (sourceIdent !== val.object.name) {
            allSameSource = false;
            break;
          }
        }
        if (allSameSource && sourceIdent) {
          context.report({
            node,
            message: `Object literal restates ${node.properties.length} properties verbatim from '${sourceIdent}'; pass '${sourceIdent}' directly instead of reshaping a parallel bag.`,
          });
        }
      },
      TSTypeLiteral(node) {
        const names = new Set();
        for (const m of node.members) {
          if (
            m.type === "TSPropertySignature" &&
            m.key?.type === "Identifier"
          ) {
            names.add(m.key.name);
          }
        }
        if (
          (names.has("ok") || names.has("success")) &&
          (names.has("data") || names.has("value")) &&
          names.has("error") &&
          names.size <= 4
        ) {
          context.report({
            node,
            message:
              "Do not model fallible results as a single `{ ok, data, error }` product type; use a discriminated union (`{ ok: true; data: T } | { ok: false; error: E }`).",
          });
        }
      },
    };
  },
};

export const noStructuralTypeForkRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow duplicate 3+ field object type shapes within a module.",
    },
    schema: [
      {
        type: "object",
        properties: scopeProperties,
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    const sourceCode = context.sourceCode;
    const seenShapes = new Map();

    function shapeSignature(members) {
      if (!Array.isArray(members) || members.length < 3) return null;
      const fields = [];
      for (const m of members) {
        if (
          m.type !== "TSPropertySignature" ||
          m.computed ||
          m.key?.type !== "Identifier" ||
          !m.typeAnnotation?.typeAnnotation
        ) {
          return null;
        }
        const opt = m.optional ? "?" : "";
        const ty = sourceCode
          .getText(m.typeAnnotation.typeAnnotation)
          .replace(/\s+/gu, " ");
        fields.push(`${m.key.name}${opt}:${ty}`);
      }
      fields.sort();
      return fields.join(";");
    }

    function checkShape(name, members, reportNode) {
      const sig = shapeSignature(members);
      if (!sig) return;
      const existing = seenShapes.get(sig);
      if (existing && existing !== name) {
        context.report({
          node: reportNode,
          message: `Type '${name}' duplicates the exact ${members.length}-field shape of '${existing}'; reuse '${existing}' instead of forking a parallel contract.`,
        });
        return;
      }
      seenShapes.set(sig, name);
    }

    return {
      TSInterfaceDeclaration(node) {
        if (node.id?.name && (!node.extends || node.extends.length === 0)) {
          checkShape(node.id.name, node.body?.body, node.id);
        }
      },
      TSTypeAliasDeclaration(node) {
        if (node.id?.name && node.typeAnnotation?.type === "TSTypeLiteral") {
          checkShape(node.id.name, node.typeAnnotation.members, node.id);
        }
      },
    };
  },
};

export const noHypotheticalSeamRule = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow unexported single-implementation interfaces or injected default dependencies only overridden in tests.",
    },
    schema: [
      {
        type: "object",
        properties: scopeProperties,
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    const interfaces = new Map();
    const implementCounts = new Map();

    return {
      TSInterfaceDeclaration(node) {
        if (node.parent?.type === "ExportNamedDeclaration") return;
        if (
          node.id?.name &&
          node.body?.body?.some((m) => m.type === "TSMethodSignature")
        ) {
          interfaces.set(node.id.name, node);
        }
      },
      ClassDeclaration(node) {
        for (const impl of node.implements ?? []) {
          if (impl.expression?.type === "Identifier") {
            const name = impl.expression.name;
            implementCounts.set(name, (implementCounts.get(name) ?? 0) + 1);
          }
        }
      },
      "Program:exit"() {
        for (const [name, node] of interfaces) {
          if (implementCounts.get(name) === 1) {
            context.report({
              node: node.id,
              message: `Interface '${name}' has only one implementation in this module; delete the hypothetical seam until a second adapter exists.`,
            });
          }
        }
      },
    };
  },
};

export const noUnresolvedDependencyTypesRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow `@ts-expect-error` or `@ts-ignore` comments that suppress unresolved module or type imports.",
    },
    schema: [
      {
        type: "object",
        properties: scopeProperties,
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    return {
      Program() {
        const comments = context.sourceCode.getAllComments?.() ?? [];
        for (const comment of comments) {
          if (/@ts-(?:expect-error|ignore)/u.test(comment.value)) {
            context.report({
              loc: comment.loc,
              message:
                "Do not suppress TypeScript errors with `@ts-expect-error` or `@ts-ignore`; fix the underlying type or dependency contract.",
            });
          }
        }
      },
    };
  },
};
