import ts from "typescript";

import { schemaValidationCallParts } from "../../semantic-adapters/projection/schema-provenance.ts";
import { noKnownValueWideningRule } from "../../oxlint-plugin/anti-slop/rules/no-known-value-widening.js";
import { noWidenThenAssertRule } from "../../oxlint-plugin/anti-slop/rules/no-widen-then-assert.js";
import {
  isMutatedObjectBinding,
  isPopulatedObjectExpression,
} from "../../oxlint-plugin/anti-slop/shared/dictionary-types.js";
import { defineTypeScriptRule } from "../../semantic-adapters/kernel/rule-kernel.ts";

const TS_TYPE_FLAG_ANY = 1;
const TS_TYPE_FLAG_UNKNOWN = 2;

function mergeVisitors(...visitors) {
  const handlers = new Map();
  for (const visitor of visitors) {
    for (const [selector, handler] of Object.entries(visitor)) {
      const selectorHandlers = handlers.get(selector) ?? [];
      selectorHandlers.push(handler);
      handlers.set(selector, selectorHandlers);
    }
  }
  return Object.fromEntries(
    [...handlers].map(([selector, selectorHandlers]) => [
      selector,
      (node) => {
        for (const handler of selectorHandlers) handler(node);
      },
    ])
  );
}

function isUnknownTypeNode(typeNode) {
  return typeNode?.type === "TSUnknownKeyword";
}

function erasedInitializer(node) {
  if (isUnknownTypeNode(node.id.typeAnnotation?.typeAnnotation)) {
    return node.init?.type === "TSAsExpression"
      ? node.init.expression
      : node.init;
  }
  if (
    node.init?.type === "TSAsExpression" &&
    isUnknownTypeNode(node.init.typeAnnotation)
  ) {
    return node.init.expression;
  }
  return null;
}

function isContractFreeLiteral(expression) {
  return Boolean(
    (expression?.type === "ObjectExpression" &&
      expression.properties.length === 0) ||
    (expression?.type === "ArrayExpression" && expression.elements.length === 0)
  );
}

function hasSpecificType(checker, services, expression) {
  const tsNode = services.esTreeNodeToTSNodeMap.get(expression);
  if (!tsNode) {
    return false;
  }
  const type = checker.getTypeAtLocation(tsNode);
  return Boolean(
    type && !(type.flags & (TS_TYPE_FLAG_ANY | TS_TYPE_FLAG_UNKNOWN))
  );
}

function isParseArgument(identifier, services, checker) {
  const call = identifier.parent;
  if (call?.type !== "CallExpression") {
    return false;
  }
  const parts = schemaValidationCallParts(call, services, checker);
  return parts?.arg === identifier;
}

function isNamedContractCast(identifier) {
  const cast = identifier.parent;
  return Boolean(
    cast?.type === "TSAsExpression" &&
    cast.expression === identifier &&
    cast.typeAnnotation?.type === "TSTypeReference"
  );
}

function reestablishingReference(references, services, checker) {
  return references.some((reference) => {
    if (!reference.isRead()) {
      return false;
    }
    const identifier = reference.identifier;
    return (
      isParseArgument(identifier, services, checker) ||
      isNamedContractCast(identifier)
    );
  });
}

function unwrapTsTransparentTypeNode(typeNode) {
  let current = typeNode;
  while (current) {
    if (ts.isParenthesizedTypeNode(current)) {
      current = current.type;
      continue;
    }
    if (
      ts.isTypeOperatorNode(current) &&
      current.operator === ts.SyntaxKind.ReadonlyKeyword
    ) {
      current = current.type;
      continue;
    }
    if (
      ts.isTypeReferenceNode(current) &&
      ts.isIdentifier(current.typeName) &&
      current.typeName.text === "Readonly" &&
      current.typeArguments?.length === 1
    ) {
      current = current.typeArguments[0];
      continue;
    }
    break;
  }
  return current;
}

function isClosedKeyDomainType(keyType) {
  if (!keyType) {
    return false;
  }
  const openFlags =
    ts.TypeFlags.Any |
    ts.TypeFlags.Unknown |
    ts.TypeFlags.Never |
    ts.TypeFlags.String |
    ts.TypeFlags.Number |
    ts.TypeFlags.ESSymbol;
  if (keyType.flags & openFlags) {
    return false;
  }
  if (keyType.isUnion()) {
    return (
      keyType.types.length > 0 &&
      keyType.types.every((member) => (member.flags & openFlags) === 0)
    );
  }
  return true;
}

function classifyClosedCaseTableAnnotation(
  checker,
  tsTypeNode,
  visited = new Set()
) {
  const current = unwrapTsTransparentTypeNode(tsTypeNode);
  if (!current) {
    return null;
  }
  if (ts.isMappedTypeNode(current)) {
    if (current.questionToken) {
      return null;
    }
    const constraint = current.typeParameter.constraint;
    if (!constraint) {
      return null;
    }
    const constraintType = checker.getTypeFromTypeNode(constraint);
    return isClosedKeyDomainType(constraintType) ? "mapped type" : null;
  }
  if (!ts.isTypeReferenceNode(current)) {
    return null;
  }
  if (
    ts.isIdentifier(current.typeName) &&
    current.typeName.text === "Record" &&
    current.typeArguments?.length === 2
  ) {
    const keyType = checker.getTypeFromTypeNode(current.typeArguments[0]);
    return isClosedKeyDomainType(keyType) ? "Record<K, V>" : null;
  }
  let symbol = checker.getSymbolAtLocation(current.typeName);
  if (!symbol) {
    return null;
  }
  if (symbol.flags & ts.SymbolFlags.Alias) {
    symbol = checker.getAliasedSymbol(symbol);
  }
  if (!symbol || visited.has(symbol)) {
    return null;
  }
  visited.add(symbol);
  for (const declaration of symbol.declarations ?? []) {
    if (ts.isTypeAliasDeclaration(declaration)) {
      const matched = classifyClosedCaseTableAnnotation(
        checker,
        declaration.type,
        visited
      );
      if (matched) {
        return matched;
      }
    }
  }
  return null;
}

export function ruleNoAppeasementErasure() {
  return defineTypeScriptRule({
    ruleName: "no-appeasement-erasure",
    skipGenerated: false,
    meta: {
      type: "problem",
      docs: {
        description:
          "Detect known values widened into broad contracts, including flows that later re-establish a narrower contract and case tables annotated with Record<K, V> or mapped types instead of satisfies.",
      },
      messages: {
        widening:
          "The explicit {{target}} type on {{subject}} discards known type evidence. Keep inference, validate with `satisfies`, or use a named owner contract.",
        widenThenAssert:
          'Binding "{{name}}" discards type evidence and later recreates it with an assertion. Keep the precise type from initialization through use; parse boundary input once.',
        caseTableAnnotation:
          'Annotating case table "{{name}}" with a {{annotationKind}} widens its per-key entry types and erases literal evidence. Remove the variable type annotation and validate with `satisfies` (`const {{name}} = { ... } satisfies ...`) instead.',
      },
      schema: [],
    },
    visitors({ context, checker, services }) {
      const localVisitors = {
        VariableDeclarator(node) {
          if (node.id.type !== "Identifier" || node.parent?.kind !== "const") {
            return;
          }
          const typeAnnotationNode = node.id.typeAnnotation?.typeAnnotation;
          if (typeAnnotationNode && isPopulatedObjectExpression(node.init)) {
            const tsTypeNode =
              services.esTreeNodeToTSNodeMap.get(typeAnnotationNode);
            const annotationKind =
              tsTypeNode &&
              classifyClosedCaseTableAnnotation(checker, tsTypeNode);
            if (annotationKind) {
              const [declaredBinding] =
                context.sourceCode.getDeclaredVariables(node);
              if (declaredBinding && !isMutatedObjectBinding(declaredBinding)) {
                context.report({
                  node: node.id.typeAnnotation,
                  messageId: "caseTableAnnotation",
                  data: {
                    name: node.id.name,
                    annotationKind,
                  },
                });
                return;
              }
            }
          }
          const initializer = erasedInitializer(node);
          if (
            !initializer ||
            isContractFreeLiteral(initializer) ||
            !hasSpecificType(checker, services, initializer)
          ) {
            return;
          }
          const [declaredBinding] =
            context.sourceCode.getDeclaredVariables(node);
          if (
            !declaredBinding ||
            !reestablishingReference(
              declaredBinding.references,
              services,
              checker
            )
          ) {
            return;
          }
          context.report({
            node: node.id,
            message:
              "Appeasement erasure: this value already has a known type, and widening it to unknown only makes the parse or cast below look earned. Keep the compiler's type and validate at the real boundary instead.",
          });
        },
      };
      return mergeVisitors(
        noKnownValueWideningRule.createOnce(context),
        noWidenThenAssertRule.createOnce(context),
        localVisitors
      );
    },
  });
}
