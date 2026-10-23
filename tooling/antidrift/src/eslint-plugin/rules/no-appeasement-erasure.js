import ts from "typescript";

import { schemaValidationCallParts } from "../../semantic-adapters/projection/schema-provenance.ts";
import { defineTypeScriptRule } from "../../semantic-adapters/kernel/rule-kernel.ts";

const TS_TYPE_FLAG_ANY = 1;
const TS_TYPE_FLAG_UNKNOWN = 2;

const TRANSPARENT_WRAPPERS = new Set([
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSTypeAssertion",
  "TSNonNullExpression",
]);

function isGlobalMethodCall(node, objectName, methodName) {
  const callee = node?.type === "CallExpression" ? node.callee : null;
  return (
    callee?.type === "MemberExpression" &&
    !callee.computed &&
    callee.object.type === "Identifier" &&
    callee.object.name === objectName &&
    callee.property.type === "Identifier" &&
    callee.property.name === methodName
  );
}

// A case table is an object literal with entries, optionally frozen.
function isCaseTableLiteral(expression) {
  let current = expression;
  while (current && TRANSPARENT_WRAPPERS.has(current.type)) {
    current = current.expression;
  }
  if (isGlobalMethodCall(current, "Object", "freeze")) {
    [current] = current.arguments;
  }
  return current?.type === "ObjectExpression" && current.properties.length > 0;
}

function writesThroughMember(identifier) {
  const member = identifier.parent;
  if (member?.type !== "MemberExpression" || member.object !== identifier) {
    return false;
  }
  const writer = member.parent;
  return (
    (writer?.type === "AssignmentExpression" && writer.left === member) ||
    (writer?.type === "UpdateExpression" && writer.argument === member) ||
    (writer?.type === "UnaryExpression" &&
      writer.operator === "delete" &&
      writer.argument === member)
  );
}

// A table written after its declaration is state, not a case table.
function isWrittenAfterDeclaration(binding) {
  return binding.references.some(
    (reference) =>
      (!reference.init && reference.isWrite()) ||
      writesThroughMember(reference.identifier) ||
      (isGlobalMethodCall(reference.identifier.parent, "Object", "assign") &&
        reference.identifier.parent.arguments[0] === reference.identifier)
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
          "Detect known values widened to unknown and then re-established by a parse or cast, and case tables annotated with Record<K, V> or mapped types instead of satisfies.",
      },
      messages: {
        caseTableAnnotation:
          'Annotating case table "{{name}}" with a {{annotationKind}} widens its per-key entry types and erases literal evidence. Remove the variable type annotation and validate with `satisfies` (`const {{name}} = { ... } satisfies ...`) instead.',
      },
      schema: [],
    },
    visitors({ context, checker, services }) {
      return {
        VariableDeclarator(node) {
          if (node.id.type !== "Identifier" || node.parent?.kind !== "const") {
            return;
          }
          const typeAnnotationNode = node.id.typeAnnotation?.typeAnnotation;
          if (typeAnnotationNode && isCaseTableLiteral(node.init)) {
            const tsTypeNode =
              services.esTreeNodeToTSNodeMap.get(typeAnnotationNode);
            const annotationKind =
              tsTypeNode &&
              classifyClosedCaseTableAnnotation(checker, tsTypeNode);
            if (annotationKind) {
              const [declaredBinding] =
                context.sourceCode.getDeclaredVariables(node);
              if (
                declaredBinding &&
                !isWrittenAfterDeclaration(declaredBinding)
              ) {
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
    },
  });
}
