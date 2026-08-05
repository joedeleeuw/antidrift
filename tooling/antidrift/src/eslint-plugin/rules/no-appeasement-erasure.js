import { isEffectDecodeApplication } from "../../semantic-adapters/effect-schema.mjs";
import {
  ZOD_VALIDATION_METHODS,
  zodParseCallParts,
} from "../../semantic-adapters/schema-provenance.mjs";
import {
  missingTypeServicesVisitors,
  requireTypeServices,
} from "./type-services.js";

const TS_TYPE_FLAG_ANY = 1;
const TS_TYPE_FLAG_UNKNOWN = 2;

function isUnknownTypeNode(typeNode) {
  return typeNode?.type === "TSUnknownKeyword";
}

// `const x: unknown = expr` and `const x = expr as unknown` are the same erasure.
function erasedInitializer(node) {
  if (isUnknownTypeNode(node.id.typeAnnotation?.typeAnnotation)) {
    return node.init?.type === "TSAsExpression" ? node.init.expression : node.init;
  }
  if (
    node.init?.type === "TSAsExpression" &&
    isUnknownTypeNode(node.init.typeAnnotation)
  ) {
    return node.init.expression;
  }
  return null;
}

// `{} as unknown` / `[] as unknown` are placeholders and sentinels. The literal
// carries no contract, so widening it discards nothing.
function isContractFreeLiteral(expression) {
  return Boolean(
    (expression?.type === "ObjectExpression" &&
      expression.properties.length === 0) ||
    (expression?.type === "ArrayExpression" && expression.elements.length === 0),
  );
}

function hasSpecificType(checker, services, expression) {
  const tsNode = services.esTreeNodeToTSNodeMap.get(expression);
  if (!tsNode) {
    return false;
  }
  const type = checker.getTypeAtLocation(tsNode);
  return Boolean(
    type && !(type.flags & (TS_TYPE_FLAG_ANY | TS_TYPE_FLAG_UNKNOWN)),
  );
}

function isParseArgument(identifier, services, checker) {
  const call = identifier.parent;
  if (call?.type !== "CallExpression" || call.arguments[0] !== identifier) {
    return false;
  }
  return (
    Boolean(
      zodParseCallParts(call, services, checker, ZOD_VALIDATION_METHODS),
    ) || isEffectDecodeApplication(call, services, checker)
  );
}

function isNamedContractCast(identifier) {
  const cast = identifier.parent;
  return Boolean(
    cast?.type === "TSAsExpression" &&
    cast.expression === identifier &&
    cast.typeAnnotation?.type === "TSTypeReference",
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

export function ruleNoAppeasementErasure() {
  return {
    meta: {
      type: "problem",
      docs: {
        description:
          "Detect widening a known type to unknown and then re-establishing a contract from it. The erasure discards what the compiler proved and converts a compile-time contract into a runtime check.",
      },
      schema: [],
    },
    create(context) {
      const services = requireTypeServices(context);
      if (!services) {
        return missingTypeServicesVisitors(context, "no-appeasement-erasure");
      }
      const checker = services.program.getTypeChecker();
      return {
        VariableDeclarator(node) {
          // A reassigned binding is a traversal cursor, not a boundary value.
          if (
            node.id.type !== "Identifier" ||
            node.parent?.kind !== "const"
          ) {
            return;
          }
          const initializer = erasedInitializer(node);
          if (
            !initializer ||
            isContractFreeLiteral(initializer) ||
            !hasSpecificType(checker, services, initializer)
          ) {
            return;
          }
          const [variable] = context.sourceCode.getDeclaredVariables(node);
          if (
            !variable ||
            !reestablishingReference(variable.references, services, checker)
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
  };
}
