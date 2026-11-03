import {
  checkDiscardedDecode,
  checkSchemaCatch,
  checkPositionalOptions,
  checkRepairOnReadTernary,
  checkSerializationRoundtrip,
  isAliasedRawDeserialize,
  isPassedToDecoder,
  isRawDeserializeCall,
  RAW_DESERIALIZE_CAST_MESSAGE,
} from "./boundary-decode-checks.js";
import {
  checkCodecRoundtrip,
  checkRedundantSchemaParse,
} from "./schema-reparse-checks.js";
import { isRuleFile, scopeProperties } from "../shared/rule-scope.js";
import {
  resolveSchemaBuilderCall,
  schemaReceiverVerdict,
} from "../shared/runtime-schema-libraries.js";
import {
  findVariable,
  isFunctionLike,
  isTestFile,
  staticPropertyKey,
  unwrapExpression,
} from "../shared/scope.js";

const SCOPE_SCHEMA = [
  { type: "object", properties: scopeProperties, additionalProperties: false },
];

function checkJsonStringFields(node, context) {
  const builder = resolveSchemaBuilderCall(node, context.sourceCode);
  if (
    builder?.method !== "object" ||
    builder.args[0]?.type !== "ObjectExpression"
  ) {
    return;
  }
  for (const property of builder.args[0].properties) {
    const name = staticPropertyKey(property);
    if (
      name &&
      /[A-Za-z0-9]Json$|^json[A-Z]/u.test(name) &&
      resolveSchemaBuilderCall(property.value, context.sourceCode)?.method ===
        "string"
    ) {
      context.report({
        node: property,
        message: `Schema field '${name}' stores opaque JSON as a string; decode its structure at the boundary with a nested schema.`,
      });
    }
  }
}

export const noUnsafeDeserializeRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow casting raw or aliased JSON.parse / response.json() results to domain types, string-or-object repair-on-read ternaries, and JSON stringify/parse value round-trips.",
    },
    schema: SCOPE_SCHEMA,
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    const sourceCode = context.sourceCode;
    return {
      CallExpression(node) {
        checkJsonStringFields(node, context);
        checkSerializationRoundtrip(node, context);
      },
      ConditionalExpression(node) {
        checkRepairOnReadTernary(node, context);
      },
      TSAsExpression(node) {
        if (
          node.typeAnnotation?.type !== "TSUnknownKeyword" &&
          (isRawDeserializeCall(node.expression) ||
            isAliasedRawDeserialize(node.expression, sourceCode))
        ) {
          context.report({ node, message: RAW_DESERIALIZE_CAST_MESSAGE });
        }
      },
      VariableDeclarator(node) {
        if (!node.init || !isRawDeserializeCall(node.init)) return;
        const ann = node.id?.typeAnnotation?.typeAnnotation;
        if (!ann || ann.type === "TSUnknownKeyword") return;
        if (isPassedToDecoder(node.init, sourceCode)) return;
        context.report({
          node,
          message:
            "Do not assign raw deserialized JSON directly to an explicitly typed binding; decode with a schema validator first.",
        });
      },
    };
  },
};

const UNKNOWN_RECORD_NAMES = new Set([
  "UnknownRecord",
  "JsonObject",
  "JsonRecord",
]);

function isUnknownPreservingReference(typeNode) {
  if (typeNode.typeName?.type !== "Identifier") return false;
  const name = typeNode.typeName.name;
  const typeArgs = typeNode.typeArguments?.params ?? [];
  if (UNKNOWN_RECORD_NAMES.has(name)) return true;
  if (name === "Record" && typeArgs.length === 2) {
    return isUnknownPreservingAssertionType(typeArgs[1]);
  }
  return (
    (name === "Readonly" || name === "Partial" || name === "ReadonlyArray") &&
    typeArgs.length === 1 &&
    isUnknownPreservingAssertionType(typeArgs[0])
  );
}

function isUnknownPreservingAssertionType(typeNode) {
  if (!typeNode) return false;
  if (
    typeNode.type === "TSUnknownKeyword" ||
    typeNode.type === "TSNullKeyword" ||
    typeNode.type === "TSUndefinedKeyword"
  ) {
    return true;
  }
  if (typeNode.type === "TSUnionType") {
    return typeNode.types.every(isUnknownPreservingAssertionType);
  }
  if (typeNode.type === "TSArrayType") {
    return isUnknownPreservingAssertionType(typeNode.elementType);
  }
  if (
    typeNode.type === "TSTypeOperator" &&
    typeNode.operator === "readonly" &&
    isUnknownPreservingAssertionType(typeNode.typeAnnotation)
  ) {
    return true;
  }
  if (typeNode.type === "TSTypeReference") {
    return isUnknownPreservingReference(typeNode);
  }
  if (typeNode.type === "TSTypeLiteral") {
    return (
      typeNode.members.length > 0 &&
      typeNode.members.every(
        (member) =>
          (member.type === "TSPropertySignature" ||
            member.type === "TSIndexSignature") &&
          isUnknownPreservingAssertionType(
            member.typeAnnotation?.typeAnnotation
          )
      )
    );
  }
  return false;
}

function checkUnknownFunction(node, context, probeThreshold) {
  const filename = (context.filename ?? "").replaceAll("\\", "/");
  if (
    isTestFile(filename) ||
    node.returnType?.typeAnnotation?.type === "TSTypePredicate"
  ) {
    return;
  }
  const sourceCode = context.sourceCode;
  for (const parameter of node.params) {
    if (
      parameter.type !== "Identifier" ||
      parameter.typeAnnotation?.typeAnnotation?.type !== "TSUnknownKeyword"
    ) {
      continue;
    }
    const binding = findVariable(sourceCode, parameter);
    if (!binding) continue;
    let inCheckCount = 0;
    for (const ref of binding.references) {
      const parent = ref.identifier?.parent;
      if (
        parent?.type === "TSAsExpression" &&
        !isUnknownPreservingAssertionType(parent.typeAnnotation)
      ) {
        context.report({
          node: parent,
          message: `Unknown input '${parameter.name}' is cast directly instead of decoded through a boundary schema.`,
        });
      }
      if (
        parent?.type === "BinaryExpression" &&
        parent.operator === "in" &&
        parent.right === ref.identifier
      ) {
        inCheckCount += 1;
      }
    }
    if (inCheckCount >= probeThreshold) {
      context.report({
        node: parameter,
        message: `Unknown input '${parameter.name}' is probed with ${inCheckCount} ad-hoc 'in' checks; decode once with a boundary schema instead.`,
      });
    }
  }
}

export const unknownInputMustBeDecodedRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow casting or probing `: unknown` boundary parameters into domain types without a schema decoder, discarded statement decodes, and `.catch(fallback)` repair-on-read.",
    },
    schema: [
      {
        type: "object",
        properties: {
          ...scopeProperties,
          defensiveShapeProbeThreshold: { type: "number" },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    const reportedObjects = new WeakSet();
    const probeThreshold =
      context.options[0]?.defensiveShapeProbeThreshold ?? 2;
    const checkFunction = (node) =>
      checkUnknownFunction(node, context, probeThreshold);

    return {
      CallExpression(node) {
        checkSchemaCatch(node, reportedObjects, context);
      },
      ExpressionStatement(node) {
        checkDiscardedDecode(node, context);
      },
      FunctionDeclaration: checkFunction,
      FunctionExpression: checkFunction,
      ArrowFunctionExpression: checkFunction,
    };
  },
};

export const noRedundantZodParseRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow re-parsing already-decoded values: same-schema re-parse, element re-parse, closed-schema JSON string tunnels, and decode-then-re-encode codec round-trips.",
    },
    schema: SCOPE_SCHEMA,
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    return {
      CallExpression(node) {
        checkRedundantSchemaParse(node, context);
        checkCodecRoundtrip(node, context);
      },
    };
  },
};

function isIdentityTransform(parameter, body) {
  const expr = unwrapExpression(body);
  if (!expr) return false;
  if (parameter.type === "Identifier") {
    return expr.type === "Identifier" && expr.name === parameter.name;
  }
  if (
    parameter.type === "ObjectPattern" &&
    parameter.properties.length > 0 &&
    expr.type === "ObjectExpression" &&
    expr.properties.length === parameter.properties.length
  ) {
    const bindings = new Map();
    for (const prop of parameter.properties) {
      if (
        prop.type !== "Property" ||
        prop.computed ||
        prop.key?.type !== "Identifier" ||
        prop.value?.type !== "Identifier"
      ) {
        return false;
      }
      bindings.set(prop.key.name, prop.value.name);
    }
    return expr.properties.every(
      (property) =>
        property.type === "Property" &&
        !property.computed &&
        property.key?.type === "Identifier" &&
        property.value?.type === "Identifier" &&
        bindings.get(property.key.name) === property.value.name
    );
  }
  return false;
}

export const noIdentitySchemaTransformRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow `.transform(x => x)` or exhaustive destructuring `.transform(({ a, b }) => ({ a, b }))` no-ops on schemas, and positional reads of schema `.options`.",
    },
    schema: SCOPE_SCHEMA,
  },
  create(context) {
    if (!isRuleFile(context)) return {};

    return {
      MemberExpression(node) {
        checkPositionalOptions(node, context);
      },
      CallExpression(node) {
        if (
          node.callee?.type !== "MemberExpression" ||
          node.callee.computed ||
          node.callee.property?.type !== "Identifier" ||
          node.callee.property.name !== "transform" ||
          schemaReceiverVerdict(node.callee, context.sourceCode) === "disproven"
        ) {
          return;
        }
        const callback = unwrapExpression(node.arguments[0]);
        if (
          !isFunctionLike(callback) ||
          callback.async ||
          callback.params.length !== 1
        ) {
          return;
        }
        const parameter = callback.params[0];
        const returned =
          callback.body?.type === "BlockStatement" &&
          callback.body.body.length === 1 &&
          callback.body.body[0].type === "ReturnStatement"
            ? callback.body.body[0].argument
            : callback.body;
        if (isIdentityTransform(parameter, returned)) {
          context.report({
            node,
            message:
              "Schema `.transform()` performs an identity pass-through; remove the no-op transform.",
          });
        }
      },
    };
  },
};

export const noSchemaValidatorTranscodingRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow transcoding a runtime schema through `toJSONSchema` / `zodToJsonSchema` into another runtime validator.",
    },
    schema: SCOPE_SCHEMA,
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    function isJsonSchemaCall(node) {
      const expr = unwrapExpression(node);
      if (expr?.type !== "CallExpression") return false;
      const callee = unwrapExpression(expr.callee);
      if (callee?.type === "Identifier") {
        return (
          callee.name === "zodToJsonSchema" || callee.name === "toJSONSchema"
        );
      }
      return (
        callee?.type === "MemberExpression" &&
        callee.property?.type === "Identifier" &&
        callee.property.name === "toJSONSchema"
      );
    }
    function isLocalFunctionCall(node) {
      const callee = unwrapExpression(node.callee);
      if (callee?.type !== "Identifier") return false;
      const binding = findVariable(context.sourceCode, callee);
      const def = binding?.defs?.[0];
      return (
        def?.type === "FunctionName" ||
        (def?.type === "Variable" && isFunctionLike(def.node?.init))
      );
    }
    return {
      CallExpression(node) {
        if (isLocalFunctionCall(node)) return;
        if (node.arguments.some(isJsonSchemaCall)) {
          context.report({
            node,
            message:
              "Do not transcode a schema through JSON Schema into another validator; share one canonical schema definition.",
          });
        }
      },
    };
  },
};
