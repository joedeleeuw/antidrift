import { emitSemanticFact } from "../../policy/lib/semantic-facts.mjs";
import {
  closedZodTransformInputKeys,
  zodTransformCallParts,
} from "../../semantic-adapters/projection/schema-provenance.ts";
import { defineTypeScriptRule } from "../../semantic-adapters/kernel/rule-kernel.ts";

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

function identityCallbackParameter(callback) {
  if (callback.async || callback.generator || callback.params.length !== 1) {
    return null;
  }
  const [parameter] = callback.params;
  return parameter.type === "Identifier" || parameter.type === "ObjectPattern"
    ? parameter
    : null;
}

function returnedExpression(callback) {
  if (callback.body.type !== "BlockStatement") {
    return { expression: callback.body, returnStyle: "implicit" };
  }
  if (callback.body.body.length !== 1) return null;
  const [statement] = callback.body.body;
  return statement.type === "ReturnStatement"
    ? { expression: statement.argument, returnStyle: "block-return" }
    : null;
}

function returnedObject(callback) {
  const returned = returnedExpression(callback);
  if (returned?.expression?.type !== "ObjectExpression") return null;
  return { object: returned.expression, returnStyle: returned.returnStyle };
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
  const parameter = identityCallbackParameter(callback);
  if (!parameter) return null;
  const returned = returnedObject(callback);
  if (!returned) return null;
  const outputKeys = identityOutputKeys(returned.object, parameter);
  if (!outputKeys || !sameKeys(inputKeys, outputKeys)) return null;
  return {
    inputKeys: [...inputKeys],
    outputKeys: [...outputKeys].sort((left, right) =>
      left.localeCompare(right)
    ),
    parameterStyle:
      parameter.type === "Identifier" ? "identifier" : "object-pattern",
    returnStyle: returned.returnStyle,
  };
}

function directIdentityProof(callback) {
  const parameter = identityCallbackParameter(callback);
  if (parameter?.type !== "Identifier") return null;
  const returned = returnedExpression(callback);
  if (
    returned?.expression?.type !== "Identifier" ||
    returned.expression.name !== parameter.name
  ) {
    return null;
  }
  return {
    inputKeys: null,
    outputKeys: null,
    parameterStyle: "identifier",
    returnStyle:
      returned.returnStyle === "implicit" ? "direct" : returned.returnStyle,
    relation: "identity-value",
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
      inputShape: proof.inputKeys ? { keys: proof.inputKeys } : null,
      outputShape: proof.outputKeys ? { keys: proof.outputKeys } : null,
      transform: {
        parameterStyle: proof.parameterStyle,
        relation: proof.relation ?? "identity-object-reconstruction",
        returnStyle: proof.returnStyle,
      },
    },
  });
}

export function ruleNoIdentitySchemaTransform() {
  return defineTypeScriptRule({
    ruleName: "no-identity-schema-transform",
    skipGenerated: false,
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow Zod transforms that return their input unchanged or reconstruct the schema's input object without changing its shape or values.",
      },
      schema: [],
      messages: {
        identitySchemaTransform:
          "This Zod transform returns its input unchanged. Remove the identity transform and infer the schema output directly.",
      },
    },
    visitors({ context, checker, services }) {
      return {
        CallExpression(node) {
          const parts = zodTransformCallParts(node, services, checker);
          if (!parts) return;
          const proof =
            directIdentityProof(parts.callback) ??
            (() => {
              const inputKeys = closedZodTransformInputKeys(
                parts.callee.object,
                services,
                checker
              );
              return inputKeys
                ? identityTransformProof(parts.callback, inputKeys)
                : null;
            })();
          if (!proof) return;
          emitIdentityTransformFact(context, node, proof);
          context.report({
            node,
            messageId: "identitySchemaTransform",
          });
        },
      };
    },
  });
}
