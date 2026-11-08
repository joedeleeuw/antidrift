import {
  checkDiscardedDecode,
  checkSchemaCatch,
  checkRepairOnReadTernary,
  checkSerializationRoundtrip,
  isAliasedRawDeserialize,
  isPassedToDecoder,
  isRawDeserializeCall,
  RAW_DESERIALIZE_CAST_MESSAGE,
  resolveTauriIpcMethod,
} from "./boundary-decode-checks.js";
import {
  checkCatchClauseSchemaDecode,
  checkUncheckedSplitNumericCoercion,
  checkUnvalidatedSchemaHole,
} from "./boundary-schema-hole-checks.js";
import { isRuleFile, scopeProperties } from "../shared/rule-scope.js";
import { resolveSchemaBuilderCall } from "../shared/runtime-schema-libraries.js";
import {
  findVariable,
  isFunctionLike,
  isTestFile,
  staticPropertyKey,
} from "../shared/scope.js";
import {
  getResolvedType,
  resolvedDeclarationFiles,
} from "../shared/type-services.js";
import { patternIdentifiers } from "./static-resolution.js";

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

function isUnknownTypedIdentifier(ident, parameter, sourceCode) {
  if (
    ident.typeAnnotation?.typeAnnotation?.type === "TSUnknownKeyword" ||
    parameter.typeAnnotation?.typeAnnotation?.type === "TSUnknownKeyword"
  ) {
    return true;
  }
  const resolved = getResolvedType(ident, sourceCode);
  return Boolean(resolved && ((resolved.flags ?? 0) & 2) !== 0);
}

function checkUnknownParameterBinding(ident, context, probeThreshold) {
  const binding = findVariable(context.sourceCode, ident);
  if (!binding) return;
  let inCheckCount = 0;
  let hasInstanceofGuard = false;
  for (const ref of binding.references) {
    const parent = ref.identifier?.parent;
    if (
      (parent?.type === "TSAsExpression" ||
        parent?.type === "TSTypeAssertion") &&
      !isUnknownPreservingAssertionType(parent.typeAnnotation)
    ) {
      context.report({
        node: parent,
        message: `Unknown input '${ident.name}' is cast directly instead of decoded through a boundary schema.`,
      });
    }
    if (
      parent?.type === "BinaryExpression" &&
      parent.operator === "instanceof" &&
      parent.left === ref.identifier
    ) {
      hasInstanceofGuard = true;
    }
    if (
      parent?.type === "BinaryExpression" &&
      parent.operator === "in" &&
      parent.right === ref.identifier
    ) {
      inCheckCount += 1;
    }
  }
  if (!hasInstanceofGuard && inCheckCount >= probeThreshold) {
    context.report({
      node: ident,
      message: `Unknown input '${ident.name}' is probed with ${inCheckCount} ad-hoc 'in' checks; decode once with a boundary schema instead.`,
    });
  }
}

const GENERATED_IPC_PATH_RE =
  /(?:^|\/)(?:_generated|__generated__|generated|bindings)(?:\/|$|\.)|\.(?:gen|generated)\.[cm]?tsx?$/u;

function isGeneratedIpcTypeNode(typeNode, sourceCode) {
  let target = typeNode;
  while (target?.type === "TSArrayType") {
    target = target.elementType;
  }
  const declFiles = resolvedDeclarationFiles(target, sourceCode);
  if (
    declFiles.length > 0 &&
    declFiles.every((file) => GENERATED_IPC_PATH_RE.test(file))
  ) {
    return true;
  }
  const typeIdent =
    target?.type === "TSTypeReference" && target.typeName?.type === "Identifier"
      ? target.typeName
      : null;
  if (!typeIdent) return false;
  const def = findVariable(sourceCode, typeIdent)?.defs?.[0];
  const importSource = def?.parent?.source?.value;
  return (
    def?.type === "ImportBinding" &&
    GENERATED_IPC_PATH_RE.test(importSource ?? "")
  );
}

function checkTauriIpcTypeArguments(node, context) {
  const sourceCode = context.sourceCode;
  const method = resolveTauriIpcMethod(node, sourceCode);
  if (!method) return;
  const typeArgs = node.typeArguments ?? node.typeParameters;
  const firstArg = typeArgs?.params?.[0];
  if (
    !firstArg ||
    firstArg.type === "TSVoidKeyword" ||
    firstArg.type === "TSNeverKeyword" ||
    isUnknownPreservingAssertionType(firstArg) ||
    isPassedToDecoder(node, sourceCode) ||
    isGeneratedIpcTypeNode(firstArg, sourceCode)
  ) {
    return;
  }
  context.report({
    node: typeArgs,
    message: `Do not pass an unvalidated type argument to Tauri '${method}<...>(...)'; decode the IPC payload at the boundary with a schema validator or use generated bindings.`,
  });
}

function isUnknownPreservingReturnType(typeNode) {
  if (
    typeNode?.type === "TSTypeReference" &&
    typeNode.typeName?.type === "Identifier" &&
    typeNode.typeName.name === "Promise" &&
    typeNode.typeArguments?.params.length === 1
  ) {
    return isUnknownPreservingAssertionType(typeNode.typeArguments.params[0]);
  }
  return isUnknownPreservingAssertionType(typeNode);
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
    for (const ident of patternIdentifiers(parameter)) {
      if (isUnknownTypedIdentifier(ident, parameter, sourceCode)) {
        checkUnknownParameterBinding(ident, context, probeThreshold);
      }
    }
  }
  const returnAnn = node.returnType?.typeAnnotation;
  if (
    returnAnn &&
    returnAnn.type !== "TSAnyKeyword" &&
    !isUnknownPreservingReturnType(returnAnn) &&
    node.body?.type !== "BlockStatement" &&
    (isRawDeserializeCall(node.body, sourceCode) ||
      isAliasedRawDeserialize(node.body, sourceCode))
  ) {
    context.report({
      node: node.body,
      message:
        "Do not return raw deserialized JSON directly as an explicitly typed contract; decode with a schema validator first.",
    });
  }
}

function enclosingFunctionOrTry(node) {
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (cur.type === "TryStatement") return null;
    if (isFunctionLike(cur)) return cur;
  }
  return null;
}

function checkRawDeserializeReturn(node, context) {
  const sourceCode = context.sourceCode;
  if (
    !node.argument ||
    (!isRawDeserializeCall(node.argument, sourceCode) &&
      !isAliasedRawDeserialize(node.argument, sourceCode))
  ) {
    return;
  }
  const fnNode = enclosingFunctionOrTry(node);
  const returnAnn = fnNode?.returnType?.typeAnnotation;
  if (
    !returnAnn ||
    returnAnn.type === "TSAnyKeyword" ||
    isUnknownPreservingReturnType(returnAnn)
  ) {
    return;
  }
  context.report({
    node,
    message:
      "Do not return raw deserialized JSON directly as an explicitly typed contract; decode with a schema validator first.",
  });
}

function checkRawDeserializeAssertion(node, context) {
  const sourceCode = context.sourceCode;
  if (
    node.typeAnnotation?.type !== "TSUnknownKeyword" &&
    (isRawDeserializeCall(node.expression, sourceCode) ||
      isAliasedRawDeserialize(node.expression, sourceCode))
  ) {
    context.report({ node, message: RAW_DESERIALIZE_CAST_MESSAGE });
  }
}

function checkRawDeserializeDeclarator(node, context) {
  const sourceCode = context.sourceCode;
  if (!node.init || !isRawDeserializeCall(node.init, sourceCode)) return;
  const ann = node.id?.typeAnnotation?.typeAnnotation;
  if (!ann || ann.type === "TSUnknownKeyword") return;
  if (isPassedToDecoder(node.init, sourceCode)) return;
  context.report({
    node,
    message:
      "Do not assign raw deserialized JSON directly to an explicitly typed binding; decode with a schema validator first.",
  });
}

export const unknownInputMustBeDecodedRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow casting or probing `: unknown` boundary parameters or raw deserialized JSON (`JSON.parse`, `response.json()`) into domain types without a schema decoder, discarded statement decodes, repair-on-read ternaries, and `.catch(fallback)` repair-on-read.",
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
    const checkAssertion = (node) =>
      checkRawDeserializeAssertion(node, context);

    return {
      CallExpression(node) {
        checkJsonStringFields(node, context);
        checkSerializationRoundtrip(node, context);
        checkSchemaCatch(node, reportedObjects, context);
        checkCatchClauseSchemaDecode(node, context);
        checkUnvalidatedSchemaHole(node, context);
        checkUncheckedSplitNumericCoercion(node, context);
        checkTauriIpcTypeArguments(node, context);
      },
      ConditionalExpression(node) {
        checkRepairOnReadTernary(node, context);
      },
      ExpressionStatement(node) {
        checkDiscardedDecode(node, context);
      },
      TSAsExpression: checkAssertion,
      TSTypeAssertion: checkAssertion,
      VariableDeclarator(node) {
        checkRawDeserializeDeclarator(node, context);
      },
      ReturnStatement(node) {
        checkRawDeserializeReturn(node, context);
      },
      FunctionDeclaration: checkFunction,
      FunctionExpression: checkFunction,
      ArrowFunctionExpression: checkFunction,
    };
  },
};
