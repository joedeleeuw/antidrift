import { isJsonCall } from "./boundary-decode-checks.js";
import { topLevelTypeDeclarations } from "./type-predicate-checks.js";
import { isRuleFile, scopeProperties } from "../shared/rule-scope.js";
import {
  hasRuntimeSchemaProvenance,
  isOpenEndedJsonSchema,
  schemaReceiverVerdict,
} from "../shared/runtime-schema-libraries.js";
import {
  bindingTypeAnnotation,
  constInitializer,
  findVariable,
  isFunctionLike,
  staticPropertyKey,
  unwrapAwaitedExpression,
  unwrapExpression,
} from "../shared/scope.js";
import {
  getResolvedType,
  hasTypeChecker,
  isBroadResolvedType,
} from "../shared/type-services.js";

const DECODED_VALUE_METHODS = new Set([
  "parse",
  "parseAsync",
  "decodeUnknownSync",
  "decodeSync",
]);
const REPARSE_METHODS = new Set([
  ...DECODED_VALUE_METHODS,
  "safeParse",
  "safeParseAsync",
]);

function schemaParseCall(node, sourceCode) {
  let expr = unwrapExpression(node);
  if (expr?.type === "AwaitExpression") {
    expr = unwrapExpression(expr.argument);
  }
  if (expr?.type !== "CallExpression" || expr.arguments.length !== 1) {
    return null;
  }
  const callee = unwrapExpression(expr.callee);
  if (
    callee?.type !== "MemberExpression" ||
    callee.computed ||
    callee.property?.type !== "Identifier" ||
    !isSchemaReceiver(callee.object, sourceCode)
  ) {
    return null;
  }
  const method = callee.property.name;
  if (!REPARSE_METHODS.has(method)) return null;
  return {
    method,
    returnsDecodedValue: DECODED_VALUE_METHODS.has(method),
    schemaText: sourceCode.getText(callee.object).replaceAll(/\s+/gu, ""),
  };
}

const SCHEMA_OUTPUT_TYPE_NAMES =
  /^(?:infer|output|Infer|InferOutput|InferType|Static|Type)$/u;

function inferredSchemaFromAnnotation(ann, sourceCode, depth = 0) {
  if (!ann || depth > 4 || ann.type !== "TSTypeReference") return null;
  const typeArg = ann.typeArguments?.params?.[0];
  const rightName =
    ann.typeName?.type === "Identifier"
      ? ann.typeName.name
      : (ann.typeName?.right?.name ?? "");
  if (
    SCHEMA_OUTPUT_TYPE_NAMES.test(rightName) &&
    typeArg?.type === "TSTypeQuery" &&
    typeArg.exprName
  ) {
    return sourceCode.getText(typeArg.exprName).replaceAll(/\s+/gu, "");
  }
  if (ann.typeName?.type === "Identifier" && !ann.typeArguments) {
    const aliasDecl = topLevelTypeDeclarations(sourceCode.ast).get(
      ann.typeName.name
    );
    if (aliasDecl?.type === "TSTypeAliasDeclaration") {
      return inferredSchemaFromAnnotation(
        aliasDecl.typeAnnotation,
        sourceCode,
        depth + 1
      );
    }
  }
  return null;
}

function matchesSchemaOutputType(ann, arg, parseNode, schemaText, sourceCode) {
  if (inferredSchemaFromAnnotation(ann, sourceCode) === schemaText) {
    return true;
  }
  const schemaExpr = unwrapExpression(parseNode.callee)?.object;
  if (
    ann?.type === "TSTypeReference" &&
    ann.typeName?.type === "Identifier" &&
    !ann.typeArguments
  ) {
    const stem = schemaText.replace(/^.*\./u, "").replace(/Schema$/u, "");
    if (
      stem.length > 0 &&
      stem !== schemaText &&
      ann.typeName.name === stem &&
      hasRuntimeSchemaProvenance(schemaExpr, sourceCode)
    ) {
      return true;
    }
  }
  const resolvedArgType = hasTypeChecker(sourceCode)
    ? getResolvedType(arg, sourceCode)
    : null;
  return Boolean(
    resolvedArgType !== null &&
    !resolvedArgType.intrinsicName &&
    hasRuntimeSchemaProvenance(schemaExpr, sourceCode) &&
    !isBroadResolvedType(arg, sourceCode) &&
    resolvedArgType === getResolvedType(parseNode, sourceCode)
  );
}

function isSchemaDecodedBinding(identifier, sourceCode) {
  const def = findVariable(sourceCode, identifier)?.defs?.[0];
  if (inferredSchemaFromAnnotation(bindingTypeAnnotation(def), sourceCode)) {
    return true;
  }
  const init = unwrapAwaitedExpression(def?.node?.init);
  return Boolean(
    schemaParseCall(init, sourceCode)?.returnsDecodedValue &&
    hasRuntimeSchemaProvenance(unwrapExpression(init.callee).object, sourceCode)
  );
}

function resolveLocalSchema(expression, sourceCode, depth = 0) {
  const node = unwrapAwaitedExpression(expression);
  if (node?.type !== "Identifier" || depth >= 8) return node;
  const initializer = constInitializer(sourceCode, node);
  return initializer
    ? resolveLocalSchema(initializer, sourceCode, depth + 1)
    : node;
}

function iteratedElementSchema(collection, sourceCode) {
  const decoded = resolveLocalSchema(collection, sourceCode);
  if (!schemaParseCall(decoded, sourceCode)?.returnsDecodedValue) return null;
  const schema = resolveLocalSchema(decoded.callee.object, sourceCode);
  if (
    schema?.type !== "CallExpression" ||
    schema.callee.type !== "MemberExpression" ||
    schema.callee.computed ||
    schema.callee.property.name !== "array"
  ) {
    return null;
  }
  let element = null;
  if (schema.arguments.length === 1) element = schema.arguments[0];
  else if (schema.arguments.length === 0) element = schema.callee.object;
  return resolveLocalSchema(element, sourceCode);
}

function sameSchema(left, right, sourceCode) {
  if (!left || !right) return false;
  if (left === right) return true;
  return (
    left.type === "Identifier" &&
    right.type === "Identifier" &&
    findVariable(sourceCode, left) === findVariable(sourceCode, right)
  );
}

function isSchemaReceiver(expression, sourceCode) {
  const verdict = schemaReceiverVerdict(expression, sourceCode);
  if (verdict !== "unknown") return verdict === "proven";
  if (
    expression?.type !== "Identifier" ||
    /^(?:URL|Date|JSON|path)$/u.test(expression.name)
  ) {
    return false;
  }
  const definition = findVariable(sourceCode, expression)?.defs?.[0];
  return (
    definition?.node?.type === "VariableDeclarator" ||
    definition?.type === "Parameter"
  );
}

function enclosingMapCallback(node) {
  const parent = node.parent;
  if (parent?.type === "ArrowFunctionExpression" && parent.body === node) {
    return parent;
  }
  if (parent?.type !== "ReturnStatement" || parent.argument !== node) {
    return null;
  }
  let cur = parent;
  while (cur && !isFunctionLike(cur)) cur = cur.parent;
  return cur ?? null;
}

function isMapCallWithCallback(call, callback) {
  return (
    call?.type === "CallExpression" &&
    call.arguments[0] === callback &&
    call.callee?.type === "MemberExpression" &&
    !call.callee.computed &&
    call.callee.property?.name === "map"
  );
}

function isMappedSchemaDecode(node, sourceCode) {
  if (!hasRuntimeSchemaProvenance(node.callee.object, sourceCode)) return false;
  const callback = enclosingMapCallback(node);
  if (!callback || !isMapCallWithCallback(callback.parent, callback)) {
    return false;
  }
  const parameter = callback.params[0];
  const argument = node.arguments[0];
  return (
    parameter?.type === "Identifier" &&
    argument?.type === "Identifier" &&
    findVariable(sourceCode, parameter) === findVariable(sourceCode, argument)
  );
}

function checkIteratedElement(node, def, schemaText, context) {
  const loop = def.parent?.parent;
  const sourceCode = context.sourceCode;
  if (
    loop?.type !== "ForOfStatement" ||
    loop.left !== def.parent ||
    !hasRuntimeSchemaProvenance(node.callee.object, sourceCode) ||
    !sameSchema(
      iteratedElementSchema(loop.right, sourceCode),
      resolveLocalSchema(node.callee.object, sourceCode),
      sourceCode
    )
  ) {
    return;
  }
  context.report({
    node,
    message: `Element '${def.name.name}' of already-decoded '${context.sourceCode.getText(loop.right)}' is re-parsed by '${schemaText}'; the outer decode already validated each element.`,
  });
}

function checkDecodedBinding(node, schemaText, context) {
  const sourceCode = context.sourceCode;
  const arg = unwrapExpression(node.arguments[0]);
  if (arg?.type !== "Identifier") return;
  const def = findVariable(sourceCode, arg)?.defs?.[0];
  if (!def) return;
  if (def.node?.type === "VariableDeclarator") {
    const initializerParse = schemaParseCall(def.node.init, sourceCode);
    if (
      initializerParse?.returnsDecodedValue &&
      initializerParse.schemaText === schemaText
    ) {
      context.report({
        node,
        message: `Binding '${arg.name}' was already decoded by '${schemaText}' in this scope; reuse the decoded value instead of re-parsing.`,
      });
      return;
    }
    checkIteratedElement(node, def, schemaText, context);
  }
  if (
    matchesSchemaOutputType(
      bindingTypeAnnotation(def),
      arg,
      node,
      schemaText,
      sourceCode
    )
  ) {
    const message =
      def.type === "Parameter"
        ? `Parameter '${arg.name}' is already typed as a decoded schema output; do not re-parse internal typed values.`
        : `Binding '${arg.name}' was already decoded by '${schemaText}' in this scope; reuse the decoded value instead of re-parsing.`;
    context.report({ node, message });
  }
}

function checkJsonTunnel(node, context) {
  const sourceCode = context.sourceCode;
  const callee = unwrapExpression(node.callee);
  if (
    callee?.type !== "MemberExpression" ||
    callee.computed ||
    !REPARSE_METHODS.has(callee.property?.name)
  ) {
    return false;
  }
  const [schema, payload] =
    node.arguments.length === 2
      ? node.arguments
      : [callee.object, node.arguments[0]];
  const blobCall = unwrapAwaitedExpression(payload);
  const blob = isJsonCall(blobCall, "parse")
    ? unwrapExpression(blobCall.arguments[0])
    : null;
  if (
    blob?.type !== "MemberExpression" ||
    unwrapExpression(blob.object)?.type !== "Identifier" ||
    !hasRuntimeSchemaProvenance(schema, sourceCode) ||
    isOpenEndedJsonSchema(schema, sourceCode) ||
    !isSchemaDecodedBinding(unwrapExpression(blob.object), sourceCode)
  ) {
    return false;
  }
  context.report({
    node,
    message: `'${sourceCode.getText(blob)}' tunnels closed schema '${sourceCode.getText(schema)}' through a JSON string inside an already-decoded value; decode the nested structure in the outer schema instead of re-parsing a string field.`,
  });
  return true;
}

const INVERSE_CODEC_VERBS = [
  ["encode", "decode"],
  ["serialize", "deserialize"],
  ["serialize", "parse"],
  ["stringify", "parse"],
  ["to", "from"],
  ["marshal", "unmarshal"],
];

function codecSides(name) {
  const match = /^([a-z]\w*?)(For|From|To)([A-Z]\w*)$/u.exec(name);
  if (!match) return null;
  const [, head, relation, tail] = match;
  return relation === "To"
    ? { output: tail.toLowerCase(), input: head.toLowerCase() }
    : { output: head.toLowerCase(), input: tail.toLowerCase() };
}

function sameDomain(left, right) {
  return left.endsWith(right) || right.endsWith(left);
}

function isInverseCodecPair(outerName, innerName) {
  const outer = codecSides(outerName);
  const inner = codecSides(innerName);
  if (
    outer &&
    inner &&
    sameDomain(outer.output, inner.input) &&
    sameDomain(outer.input, inner.output)
  ) {
    return true;
  }
  return INVERSE_CODEC_VERBS.some(([encodeVerb, decodeVerb]) => {
    const stem = outerName.slice(encodeVerb.length);
    return (
      outerName.startsWith(encodeVerb) &&
      /^[A-Z]/u.test(stem) &&
      innerName === `${decodeVerb}${stem}`
    );
  });
}

function checkCodecRoundtrip(node, context) {
  const inner = unwrapAwaitedExpression(node.arguments[0]);
  const outerCallee = unwrapExpression(node.callee);
  const innerCallee = unwrapExpression(inner?.callee);
  if (
    node.arguments.length === 1 &&
    outerCallee?.type === "Identifier" &&
    innerCallee?.type === "Identifier" &&
    inner.arguments.length > 0 &&
    isInverseCodecPair(outerCallee.name, innerCallee.name)
  ) {
    context.report({
      node,
      message: `'${outerCallee.name}(${innerCallee.name}(...))' decodes and immediately re-encodes the same value; keep the original or the decoded value instead of round-tripping through inverse codecs.`,
    });
  }
}

function checkRedundantSchemaParse(node, context) {
  const sourceCode = context.sourceCode;
  if (checkJsonTunnel(node, context)) return;
  const outer = schemaParseCall(node, sourceCode);
  if (!outer) return;
  if (outer.returnsDecodedValue && isMappedSchemaDecode(node, sourceCode)) {
    context.report({
      node,
      message:
        "Decode the collection once with an array schema instead of `.map(item => Schema.parse(item))`.",
    });
    return;
  }
  const arg = unwrapExpression(node.arguments[0]);
  const inner = schemaParseCall(arg, sourceCode);
  if (inner?.returnsDecodedValue && inner.schemaText === outer.schemaText) {
    context.report({
      node,
      message:
        "Redundant schema parse on an already-parsed expression; decode once at the boundary and reuse the typed value.",
    });
    return;
  }
  checkDecodedBinding(node, outer.schemaText, context);
}

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

function checkIdentitySchemaTransform(node, context) {
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
}

const JSON_SCHEMA_EMITTERS = new Set([
  "toJSONSchema",
  "toJsonSchema",
  "zodToJsonSchema",
]);

function isJsonSchemaCall(node) {
  const expr = unwrapExpression(node);
  if (expr?.type !== "CallExpression") return false;
  const callee = unwrapExpression(expr.callee);
  if (callee?.type === "Identifier") {
    return JSON_SCHEMA_EMITTERS.has(callee.name);
  }
  if (
    callee?.type === "MemberExpression" &&
    !callee.computed &&
    callee.property?.type === "Identifier"
  ) {
    return (
      JSON_SCHEMA_EMITTERS.has(callee.property.name) ||
      (callee.object?.type === "Identifier" &&
        callee.object.name === "JSONSchema" &&
        callee.property.name === "make")
    );
  }
  return false;
}

function isValidatorCompilerCall(node, sourceCode) {
  const callee = unwrapExpression(node.callee);
  if (hasRuntimeSchemaProvenance(callee, sourceCode)) return true;
  if (
    callee?.type === "MemberExpression" &&
    !callee.computed &&
    callee.property?.type === "Identifier" &&
    /^(?:compile|validate|addSchema)$/u.test(callee.property.name)
  ) {
    const objectName =
      callee.object?.type === "Identifier" ? callee.object.name : "";
    return /ajv|validator|schema/iu.test(objectName);
  }
  return false;
}

const TRANSCODED_SCHEMA_KEYS = new Set([
  "returns",
  "args",
  "input",
  "output",
  "schema",
]);

function isJsonSchemaExpression(node, sourceCode) {
  const expr = unwrapExpression(node);
  if (isJsonSchemaCall(expr)) return true;
  if (expr?.type === "Identifier") {
    return isJsonSchemaCall(constInitializer(sourceCode, expr));
  }
  return false;
}

function hasTranscodedRegistrationProperty(argNode, sourceCode) {
  const expr = unwrapExpression(argNode);
  if (expr?.type !== "ObjectExpression") return false;
  return expr.properties.some(
    (prop) =>
      TRANSCODED_SCHEMA_KEYS.has(staticPropertyKey(prop)) &&
      isJsonSchemaExpression(prop.value, sourceCode)
  );
}

function checkSchemaValidatorTranscoding(node, context) {
  const sourceCode = context.sourceCode;
  const directTranscode =
    isValidatorCompilerCall(node, sourceCode) &&
    node.arguments.some((arg) => isJsonSchemaExpression(arg, sourceCode));
  const registrationTranscode = node.arguments.some((arg) =>
    hasTranscodedRegistrationProperty(arg, sourceCode)
  );
  if (directTranscode || registrationTranscode) {
    context.report({
      node,
      message:
        "Do not transcode a schema through JSON Schema into another validator; share one canonical schema definition.",
    });
  }
}

export const noRedundantSchemaParseRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow redundant schema operations: re-parsing already-decoded values, closed-schema JSON string tunnels, inverse codec round-trips, identity `.transform()` no-ops, and transcoding a runtime schema through JSON Schema into another validator.",
    },
    schema: [
      {
        type: "object",
        properties: scopeProperties,
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    return {
      CallExpression(node) {
        checkRedundantSchemaParse(node, context);
        checkCodecRoundtrip(node, context);
        checkIdentitySchemaTransform(node, context);
        checkSchemaValidatorTranscoding(node, context);
      },
    };
  },
};
