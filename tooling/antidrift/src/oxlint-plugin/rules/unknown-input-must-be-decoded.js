import { findVariable } from "../../semantic-adapters/async-control-flow.mjs";
import {
  isGuardOperand,
  isNarrowedUse,
  returnsOnlyNarrowing,
} from "../unknown-narrowing.js";
import { isDecoderArgument, predicateCall } from "../unknown-predicates.js";
import {
  isBuiltinCoercionCall,
  isErrorInspectionRead,
  isParameterProperty,
  isRejectionHandlerFunction,
  isSerializerSinkUse,
  owningBinding,
} from "../unknown-sinks.js";

// Passing the whole unknown value as a call argument forwards it: the
// receiving function owns the decoding (and is checked there when it is
// first-party). Built-in coercions and serializers are use, not forwarding.
function isForwardedWhole(identifier, sourceCode) {
  const call = identifier.parent;
  return (
    call?.type === "CallExpression" &&
    call.arguments.includes(identifier) &&
    !isBuiltinCoercionCall(sourceCode, call)
  );
}

// Placing the whole value in an object literal field forwards it: TypeScript
// only accepts an unknown there when the field itself is unknown, so the
// field's reader owns the decoding.
function fillsObjectLiteralField(identifier) {
  const property = identifier.parent;
  return (
    property?.type === "Property" &&
    property.value === identifier &&
    property.parent?.type === "ObjectExpression"
  );
}

// A binding discriminated with `instanceof Error` (or another `*Error`
// class) holds a thrown value: like a rejection reason, it has no decodable
// contract, so only its inspection reads are analysed.
function isThrownValueBinding(reads) {
  return reads.some(({ identifier }) => {
    const test = identifier.parent;
    return (
      test.type === "BinaryExpression" &&
      test.operator === "instanceof" &&
      test.left === identifier &&
      test.right.type === "Identifier" &&
      test.right.name.endsWith("Error")
    );
  });
}

const castTypes = new Set(["TSAsExpression", "TSTypeAssertion"]);

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

// The parameter belongs to a decoder: a type predicate or assertion function
// (`x is T` / `asserts x is T`), or a helper whose returned expression only
// narrows the parameter.
function isDecoderParameter(node) {
  const binding = owningBinding(node);
  const owner = binding.parent;
  if (!owner.params?.includes(binding)) return false;
  if (owner.returnType?.typeAnnotation?.type === "TSTypePredicate") return true;
  return returnsOnlyNarrowing(owner, node.name);
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
        bindingNames(property.value ?? property.argument)
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
          if (isDecoderParameter(node)) return;
          const variable = findVariable(context.sourceCode, node);
          if (!variable) return;
          const writes = variable.references
            .filter((reference) => reference.isWrite() && !reference.init)
            .map((reference) => reference.identifier);
          const state = { variable, context, cache, writes };
          const reads = variable.references.filter(
            (reference) => reference.isRead() && !reference.isTypeReference
          );
          const parameterProperty = isParameterProperty(node);
          if (
            rejectionHandlerOwner(node, context.sourceCode) ||
            (!parameterProperty && isThrownValueBinding(reads))
          ) {
            const inspected = reads.some(
              ({ identifier }) =>
                isErrorInspectionRead(identifier) &&
                !isGuardOperand(identifier) &&
                (castTypes.has(identifier.parent.type) ||
                  !isNarrowedUse(identifier, state))
            );
            if (inspected) {
              context.report({
                node: node.typeAnnotation,
                messageId: "decodeUnknown",
              });
            }
            return;
          }
          // Never reassigned, serialized at least once, and otherwise only
          // tested: the value is formatted as output, not consumed as data.
          const sinkReads = reads.filter(({ identifier }) =>
            isSerializerSinkUse(context.sourceCode, identifier)
          );
          if (
            !parameterProperty &&
            writes.length === 0 &&
            sinkReads.length > 0 &&
            reads.every(
              (read) =>
                sinkReads.includes(read) || isGuardOperand(read.identifier)
            )
          ) {
            return;
          }
          const unsafe = reads.some(({ identifier }) => {
            if (identifier.parent.type === "TSTypePredicate") return false;
            // A cast asserts a type the value was never decoded to, even
            // behind a structural guard.
            if (castTypes.has(identifier.parent.type)) return true;
            if (isGuardOperand(identifier)) return false;
            if (isDecoderArgument(identifier)) return false;
            if (predicateCall(identifier.parent, variable, context, cache)) {
              return false;
            }
            if (
              !parameterProperty &&
              (isForwardedWhole(identifier, context.sourceCode) ||
                fillsObjectLiteralField(identifier))
            ) {
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
