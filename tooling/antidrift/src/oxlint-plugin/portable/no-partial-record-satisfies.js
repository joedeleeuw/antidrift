import { isRuleFile, scopeProperties } from "./scope.js";
import { isIdentifier } from "./ast.js";

const unwrapReadonlyType = (typeNode) => {
  if (
    typeNode?.type === "TSTypeReference" &&
    isIdentifier(typeNode.typeName, "Readonly")
  ) {
    return typeNode.typeArguments?.params?.at(0) ?? null;
  }
  return typeNode;
};
const isPartialRecordType = (typeNode) => {
  const outer = unwrapReadonlyType(typeNode);
  if (
    outer?.type !== "TSTypeReference" ||
    !isIdentifier(outer.typeName, "Partial")
  ) {
    return false;
  }
  const inner = unwrapReadonlyType(outer.typeArguments?.params?.at(0) ?? null);
  return (
    inner?.type === "TSTypeReference" && isIdentifier(inner.typeName, "Record")
  );
};
const isObjectLiteralExpression = (node) => {
  if (node?.type === "ObjectExpression") {
    return true;
  }
  if (
    node?.type === "TSAsExpression" &&
    node.typeAnnotation?.type === "TSTypeReference" &&
    isIdentifier(node.typeAnnotation.typeName, "const")
  ) {
    return isObjectLiteralExpression(node.expression);
  }
  return false;
};
export default {
  meta: {
    schema: [
      {
        type: "object",
        properties: scopeProperties,
        additionalProperties: false,
      },
    ],

    type: "problem",
    messages: {
      noPartialRecordSatisfies:
        "Don't pin an object literal with `satisfies Partial<Record<...>>` " +
        "— Partial cancels the totality check satisfies would otherwise " +
        "give you, so a union member can silently fall through. Make the " +
        "record total (explicit 'none'/false/null per member), narrow the " +
        "key union, or add an eslint-disable naming what absence means " +
        "for genuinely sparse data.",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};

    return {
      TSSatisfiesExpression(node) {
        if (!isPartialRecordType(node.typeAnnotation)) {
          return;
        }
        if (!isObjectLiteralExpression(node.expression)) {
          return;
        }
        context.report({ node, messageId: "noPartialRecordSatisfies" });
      },
    };
  },
};
