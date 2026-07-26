import { emitSemanticFact } from "../../policy/lib/semantic-facts.mjs";
import {
  closedZodTransformInputKeys,
  zodTransformCallParts,
} from "../../semantic-adapters/schema-provenance.mjs";
import {
  missingTypeServicesVisitors,
  requireTypeServices,
} from "./type-services.js";

function staticPropertyKey(property) {
  if (property.computed) return null;
  if (property.key.type === "Identifier") return property.key.name;
  if (
    property.key.type === "Literal" &&
    typeof property.key.value === "string"
  ) {
    return property.key.value;
  }
  return null;
}

function returnedObject(callback) {
  if (callback.body.type === "ObjectExpression") {
    return { object: callback.body, returnStyle: "implicit" };
  }
  if (
    callback.body.type !== "BlockStatement" ||
    callback.body.body.length !== 1
  ) {
    return null;
  }
  const statement = callback.body.body[0];
  if (statement.type !== "ReturnStatement") return null;
  if (statement.argument?.type !== "ObjectExpression") return null;
  return { object: statement.argument, returnStyle: "block-return" };
}

function destructuredParameterKeys(parameter) {
  const keys = new Set();
  for (const property of parameter.properties) {
    if (
      property.type !== "Property" ||
      property.kind !== "init" ||
      property.method ||
      property.computed ||
      !property.shorthand ||
      property.key.type !== "Identifier" ||
      property.value.type !== "Identifier" ||
      property.key.name !== property.value.name
    ) {
      return null;
    }
    keys.add(property.key.name);
  }
  return keys;
}

function identifierPassThroughKey(property, parameter) {
  if (
    property.value.type !== "MemberExpression" ||
    property.value.computed ||
    property.value.optional ||
    property.value.object.type !== "Identifier" ||
    property.value.object.name !== parameter.name ||
    property.value.property.type !== "Identifier"
  ) {
    return null;
  }
  return property.value.property.name;
}

function destructuredPassThroughKey(property, parameterKeys) {
  if (
    !property.shorthand ||
    property.value.type !== "Identifier" ||
    !parameterKeys.has(property.value.name)
  ) {
    return null;
  }
  return property.value.name;
}

function identityOutputKeys(object, parameter) {
  const parameterKeys =
    parameter.type === "ObjectPattern"
      ? destructuredParameterKeys(parameter)
      : null;
  if (parameter.type === "ObjectPattern" && !parameterKeys) return null;
  const outputKeys = new Set();
  for (const property of object.properties) {
    if (
      property.type !== "Property" ||
      property.kind !== "init" ||
      property.method ||
      property.computed
    ) {
      return null;
    }
    const outputKey = staticPropertyKey(property);
    if (!outputKey) return null;
    const sourceKey =
      parameter.type === "Identifier"
        ? identifierPassThroughKey(property, parameter)
        : destructuredPassThroughKey(property, parameterKeys);
    if (sourceKey !== outputKey || outputKeys.has(outputKey)) return null;
    outputKeys.add(outputKey);
  }
  return outputKeys;
}

function sameKeys(left, right) {
  if (left.size !== right.size) return false;
  return [...left].every((key) => right.has(key));
}

function identityTransformProof(callback, inputKeys) {
  if (
    callback.async ||
    callback.generator ||
    callback.params.length !== 1 ||
    (callback.params[0].type !== "Identifier" &&
      callback.params[0].type !== "ObjectPattern")
  ) {
    return null;
  }
  const returned = returnedObject(callback);
  if (!returned) return null;
  const outputKeys = identityOutputKeys(returned.object, callback.params[0]);
  if (!outputKeys || !sameKeys(inputKeys, outputKeys)) return null;
  return {
    inputKeys: [...inputKeys],
    outputKeys: [...outputKeys].sort((left, right) =>
      left.localeCompare(right),
    ),
    parameterStyle:
      callback.params[0].type === "Identifier"
        ? "identifier"
        : "object-pattern",
    returnStyle: returned.returnStyle,
  };
}

function emitIdentityTransformFact(context, node, proof) {
  return emitSemanticFact(context, node, {
    factKind: "identitySchemaTransform",
    ruleId: "antidrift/no-identity-schema-transform",
    adapterId: "typescript-eslint/schema-provenance",
    confidence: "deterministic-enforcement",
    provenance: ["AST", "TypeChecker"],
    payload: {
      diagnostic: {
        emitted: true,
        messageId: "identitySchemaTransform",
      },
      inputShape: { keys: proof.inputKeys },
      outputShape: { keys: proof.outputKeys },
      transform: {
        parameterStyle: proof.parameterStyle,
        relation: "identity-object-reconstruction",
        returnStyle: proof.returnStyle,
      },
    },
  });
}

export function ruleNoIdentitySchemaTransform() {
  return {
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow Zod transforms that reconstruct the schema's input object without changing its shape or values.",
      },
      schema: [],
      messages: {
        identitySchemaTransform:
          "This Zod transform only reconstructs the same object shape. Remove the identity transform and infer the schema output directly.",
      },
    },
    create(context) {
      const services = requireTypeServices(context);
      if (!services) {
        return missingTypeServicesVisitors(
          context,
          "no-identity-schema-transform",
        );
      }
      const checker = services.program.getTypeChecker();
      return {
        CallExpression(node) {
          const parts = zodTransformCallParts(node, services, checker);
          if (!parts) return;
          const inputKeys = closedZodTransformInputKeys(
            parts.callee.object,
            services,
            checker,
          );
          if (!inputKeys) return;
          const proof = identityTransformProof(parts.callback, inputKeys);
          if (!proof) return;
          emitIdentityTransformFact(context, node, proof);
          context.report({
            node,
            messageId: "identitySchemaTransform",
          });
        },
      };
    },
  };
}
