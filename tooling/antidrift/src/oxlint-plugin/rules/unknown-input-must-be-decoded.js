import { findVariable } from "../../semantic-adapters/async-control-flow.mjs";
import { isNarrowedUse } from "../unknown-narrowing.js";
import { isDecoderArgument, predicateCall } from "../unknown-predicates.js";
import {
  isErrorInspectionRead,
  isParameterProperty,
  isRejectionHandlerFunction,
  owningBinding,
  variableReadsOnlySinks,
} from "../unknown-sinks.js";

function unknownBinding(node) {
  if (node.typeAnnotation?.typeAnnotation.type !== "TSUnknownKeyword") {
    return false;
  }
  const binding = owningBinding(node);
  const declaration = binding.parent;
  if (declaration.type === "CatchClause") return false;
  if (declaration.type === "VariableDeclarator") {
    return declaration.id === binding;
  }
  return declaration.params?.includes(binding) === true;
}

// A rejection-handler parameter keeps its honest unknown annotation, but its
// reads are still analysed: inspection reads (assertions, member access,
// typeof operands, the right side of `in`) report, forwarding reads do not.
function rejectionHandlerOwner(node, sourceCode) {
  const binding = owningBinding(node);
  const declaration = binding.parent;
  if (!declaration.params?.includes(binding)) return null;
  return isRejectionHandlerFunction(declaration, sourceCode)
    ? declaration
    : null;
}

function bindingNames(node) {
  switch (node.type) {
    case "Identifier":
      return [node.name];
    case "AssignmentPattern":
      return bindingNames(node.left);
    case "RestElement":
      return bindingNames(node.argument);
    case "ArrayPattern":
      return node.elements.filter(Boolean).flatMap(bindingNames);
    case "ObjectPattern":
      return node.properties.flatMap((property) =>
        bindingNames(property.value ?? property.argument),
      );
    default:
      return [];
  }
}

export default function ruleUnknownInputMustBeDecoded() {
  return {
    meta: {
      type: "problem",
      docs: {
        description:
          "Require explicitly unknown inputs to be decoded before entering application logic.",
      },
      schema: [
        {
          type: "object",
          properties: {
            allows: {
              type: "array",
              items: { type: "string" },
              uniqueItems: true,
            },
          },
          additionalProperties: false,
        },
      ],
      messages: {
        decodeUnknown:
          "unknown must be decoded to an owned type at the boundary before use.",
      },
    },
    create(context) {
      const allows = new Set(context.options[0]?.allows ?? []);
      const cache = new Map();
      function checkPattern(node) {
        if (!unknownBinding(node)) return;
        const names = bindingNames(node);
        if (names.length > 0 && names.every((name) => allows.has(name))) {
          return;
        }
        context.report({
          node: node.typeAnnotation,
          messageId: "decodeUnknown",
        });
      }
      return {
        ObjectPattern: checkPattern,
        ArrayPattern: checkPattern,
        RestElement: checkPattern,
        Identifier(node) {
          if (!unknownBinding(node) || allows.has(node.name)) return;
          const variable = findVariable(context.sourceCode, node);
          if (!variable) return;
          if (rejectionHandlerOwner(node, context.sourceCode)) {
            const inspected = variable.references.some((reference) => {
              if (!reference.isRead() || reference.isTypeReference) {
                return false;
              }
              return isErrorInspectionRead(reference.identifier);
            });
            if (inspected) {
              context.report({
                node: node.typeAnnotation,
                messageId: "decodeUnknown",
              });
            }
            return;
          }
          if (
            !isParameterProperty(node) &&
            variableReadsOnlySinks(context.sourceCode, variable)
          ) {
            return;
          }
          const writes = variable.references
            .filter((reference) => reference.isWrite() && !reference.init)
            .map((reference) => reference.identifier);
          const state = { variable, context, cache, writes };
          const unsafe = variable.references.some((reference) => {
            if (!reference.isRead() || reference.isTypeReference) return false;
            const identifier = reference.identifier;
            if (identifier.parent.type === "TSTypePredicate") return false;
            if (isDecoderArgument(identifier)) return false;
            if (predicateCall(identifier.parent, variable, context, cache)) {
              return false;
            }
            return !isNarrowedUse(identifier, state);
          });
          if (unsafe) {
            context.report({
              node: node.typeAnnotation,
              messageId: "decodeUnknown",
            });
          }
        },
      };
    },
  };
}
