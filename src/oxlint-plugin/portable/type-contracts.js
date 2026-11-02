import { noKnownValueWideningRule } from "../anti-slop/rules/no-known-value-widening.js";
import { noWidenThenAssertRule } from "../anti-slop/rules/no-widen-then-assert.js";
import { mergeVisitors } from "../shared/merge-visitors.js";
import { isRuleFile, scopeProperties } from "../shared/rule-scope.js";

export const noAppeasementCastRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow appeasement type assertions (`as any`, `as unknown as T`, or casting object literals with `as T`).",
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
    function checkAssertion(node) {
      const target = node.typeAnnotation;
      if (target?.type === "TSAnyKeyword") {
        context.report({
          node,
          message:
            "Do not cast to `any`; decode untrusted values at the boundary or use a narrow type.",
        });
        return;
      }
      const inner = node.expression;
      if (
        (inner?.type === "TSAsExpression" ||
          inner?.type === "TSTypeAssertion") &&
        inner.typeAnnotation?.type !== "TSTypeReference"
      ) {
        context.report({
          node,
          message:
            "Do not chain type assertions (`as unknown as T`); fix the type contract or decode at the boundary.",
        });
        return;
      }
      if (
        inner?.type === "ObjectExpression" &&
        target?.type === "TSTypeReference" &&
        !(
          target.typeName?.type === "Identifier" &&
          target.typeName.name === "const"
        )
      ) {
        context.report({
          node,
          message:
            "Do not cast an object literal with `as T`; use `satisfies T` or a variable type annotation so missing fields fail typechecking.",
        });
      }
    }
    return {
      TSAsExpression: checkAssertion,
      TSTypeAssertion: checkAssertion,
    };
  },
};

export const noAppeasementErasureRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow widening known values to `unknown` or open dictionaries to erase type evidence.",
    },
    schema: [
      {
        type: "object",
        properties: scopeProperties,
        additionalProperties: false,
      },
    ],
    messages: {
      ...noKnownValueWideningRule.meta?.messages,
      ...noWidenThenAssertRule.meta?.messages,
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    const v1 = noKnownValueWideningRule.create
      ? noKnownValueWideningRule.create(context)
      : {};
    const v2 = noWidenThenAssertRule.create
      ? noWidenThenAssertRule.create(context)
      : {};
    return mergeVisitors(v1, v2);
  },
};

export const noNullablePositionalTupleRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow tuple types with 2 or more nullable (`T | null | undefined`) positional elements.",
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
    const aliases = new Map();

    function isNullableType(typeNode, seen = new Set()) {
      if (!typeNode) return false;
      if (
        typeNode.type === "TSNullKeyword" ||
        typeNode.type === "TSUndefinedKeyword"
      ) {
        return true;
      }
      if (typeNode.type === "TSOptionalType") return true;
      if (typeNode.type === "TSUnionType") {
        return typeNode.types.some((t) => isNullableType(t, seen));
      }
      if (
        typeNode.type === "TSTypeReference" &&
        typeNode.typeName?.type === "Identifier" &&
        !seen.has(typeNode.typeName.name)
      ) {
        seen.add(typeNode.typeName.name);
        return isNullableType(aliases.get(typeNode.typeName.name), seen);
      }
      return false;
    }

    return {
      Program(node) {
        for (const stmt of node.body) {
          const decl =
            stmt.type === "ExportNamedDeclaration" ? stmt.declaration : stmt;
          if (decl?.type === "TSTypeAliasDeclaration" && decl.id?.name) {
            aliases.set(decl.id.name, decl.typeAnnotation);
          }
        }
      },
      TSTupleType(node) {
        const elements = node.elementTypes ?? [];
        let nullableCount = 0;
        for (const elem of elements) {
          const inner =
            elem.type === "TSNamedTupleMember" ? elem.elementType : elem;
          if (elem.type === "TSNamedTupleMember" && elem.optional) {
            nullableCount += 1;
          } else if (isNullableType(inner)) {
            nullableCount += 1;
          }
        }
        if (nullableCount >= 2) {
          context.report({
            node,
            message:
              "Do not model multi-field nullable state as a positional tuple. Use a named object or explicit state union.",
          });
        }
      },
    };
  },
};

export const noRedundantTypePredicateRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow type predicates `x is T` whose parameter is already annotated with the same type `T`.",
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

    function checkFunction(node) {
      const pred = node.returnType?.typeAnnotation;
      if (pred?.type !== "TSTypePredicate" || !pred.typeAnnotation) return;
      const paramName =
        pred.parameterName?.type === "Identifier"
          ? pred.parameterName.name
          : null;
      if (!paramName) return;
      const param = node.params.find(
        (p) => p.type === "Identifier" && p.name === paramName
      );
      const paramType = param?.typeAnnotation?.typeAnnotation;
      if (!paramType) return;
      const targetType = pred.typeAnnotation.typeAnnotation;
      if (
        targetType &&
        sourceCode.getText(paramType) === sourceCode.getText(targetType)
      ) {
        context.report({
          node: pred,
          message: `Type predicate '${paramName} is ${sourceCode.getText(targetType)}' is redundant because '${paramName}' is already typed as '${sourceCode.getText(paramType)}'.`,
        });
      }
    }

    return {
      FunctionDeclaration: checkFunction,
      FunctionExpression: checkFunction,
      ArrowFunctionExpression: checkFunction,
    };
  },
};

export const noUndercheckedTypePredicateRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow user-defined type predicates on `unknown` inputs that return a boolean without checking required fields of the target contract.",
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
    const typeFields = new Map();

    function extractRequiredFields(members) {
      const fields = [];
      for (const m of members ?? []) {
        if (
          m.type === "TSPropertySignature" &&
          !m.optional &&
          m.key?.type === "Identifier"
        ) {
          fields.push(m.key.name);
        }
      }
      return fields;
    }

    function checkFunction(node) {
      const pred = node.returnType?.typeAnnotation;
      if (pred?.type !== "TSTypePredicate" || pred.asserts) return;
      const paramName =
        pred.parameterName?.type === "Identifier"
          ? pred.parameterName.name
          : null;
      if (!paramName) return;
      const param = node.params.find(
        (p) => p.type === "Identifier" && p.name === paramName
      );
      if (param?.typeAnnotation?.typeAnnotation?.type !== "TSUnknownKeyword") {
        return;
      }
      const target = pred.typeAnnotation?.typeAnnotation;
      if (
        target?.type !== "TSTypeReference" ||
        target.typeName?.type !== "Identifier"
      ) {
        return;
      }
      const required = typeFields.get(target.typeName.name);
      if (!required || required.length < 2) return;
      const bodyText = sourceCode.getText(node.body);
      if (
        bodyText.includes("instanceof") ||
        bodyText.includes("safeParse") ||
        bodyText.includes("Symbol.for")
      ) {
        return;
      }
      const checkedCount = required.filter(
        (f) =>
          bodyText.includes(`"${f}"`) ||
          bodyText.includes(`'${f}'`) ||
          bodyText.includes(`.${f}`)
      ).length;
      if (checkedCount < required.length) {
        context.report({
          node: pred,
          message: `Type predicate for '${target.typeName.name}' only checks ${checkedCount}/${required.length} required fields on an 'unknown' value; validate the full contract or use a schema decoder.`,
        });
      }
    }

    return {
      Program(node) {
        for (const stmt of node.body) {
          const decl =
            stmt.type === "ExportNamedDeclaration" ? stmt.declaration : stmt;
          if (decl?.type === "TSInterfaceDeclaration" && decl.id?.name) {
            typeFields.set(
              decl.id.name,
              extractRequiredFields(decl.body?.body)
            );
          } else if (
            decl?.type === "TSTypeAliasDeclaration" &&
            decl.id?.name &&
            decl.typeAnnotation?.type === "TSTypeLiteral"
          ) {
            typeFields.set(
              decl.id.name,
              extractRequiredFields(decl.typeAnnotation.members)
            );
          }
        }
      },
      FunctionDeclaration: checkFunction,
      FunctionExpression: checkFunction,
      ArrowFunctionExpression: checkFunction,
    };
  },
};
