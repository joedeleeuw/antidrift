import { isKnownEvidenceExpression } from "../anti-slop/shared/dictionary-types.js";
import { isJsonCall } from "./boundary-decode-checks.js";
import { topLevelTypeDeclarations } from "./type-predicate-checks.js";
import {
  hasRuntimeSchemaProvenance,
  isOpenEndedJsonSchema,
  schemaReceiverVerdict,
} from "../shared/runtime-schema-libraries.js";
import {
  findVariable,
  isFunctionLike,
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
    schemaText: sourceCode.getText(callee.object).replace(/\s+/gu, ""),
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
    return sourceCode.getText(typeArg.exprName).replace(/\s+/gu, "");
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

function bindingTypeAnnotation(def) {
  return def?.type === "Parameter"
    ? def.name?.typeAnnotation?.typeAnnotation
    : def?.node?.id?.typeAnnotation?.typeAnnotation;
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
  return Boolean(
    ann &&
    hasTypeChecker(sourceCode) &&
    hasRuntimeSchemaProvenance(schemaExpr, sourceCode) &&
    !isBroadResolvedType(arg, sourceCode) &&
    getResolvedType(arg, sourceCode) !== null &&
    getResolvedType(arg, sourceCode) === getResolvedType(parseNode, sourceCode)
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

function memberRoot(node) {
  let current = unwrapExpression(node);
  while (current?.type === "MemberExpression") {
    current = unwrapExpression(current.object);
  }
  return current?.type === "Identifier" ? current : null;
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

function isMappedSchemaDecode(node, sourceCode) {
  if (!hasRuntimeSchemaProvenance(node.callee.object, sourceCode)) return false;
  let callback = node.parent;
  if (callback?.type === "ReturnStatement" && callback.argument === node) {
    while (callback && !isFunctionLike(callback)) callback = callback.parent;
  } else if (
    callback?.type !== "ArrowFunctionExpression" ||
    callback.body !== node
  ) {
    return false;
  }
  const call = callback?.parent;
  if (
    call?.type !== "CallExpression" ||
    call.arguments[0] !== callback ||
    call.callee?.type !== "MemberExpression" ||
    call.callee.computed ||
    call.callee.property?.name !== "map"
  ) {
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
  const root = memberRoot(loop?.right);
  if (
    loop?.type !== "ForOfStatement" ||
    loop.left !== def.parent ||
    !root ||
    !hasRuntimeSchemaProvenance(node.callee.object, context.sourceCode) ||
    !isSchemaDecodedBinding(root, context.sourceCode)
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

export function checkCodecRoundtrip(node, context) {
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

function isAsUnknownExpression(node) {
  return (
    (node?.type === "TSAsExpression" || node?.type === "TSTypeAssertion") &&
    node.typeAnnotation?.type === "TSUnknownKeyword"
  );
}

function isUnknownOrAnyAnnotation(typeAnnotation) {
  const inner = typeAnnotation?.typeAnnotation;
  return inner?.type === "TSUnknownKeyword" || inner?.type === "TSAnyKeyword";
}

function rootIdentifierOf(expr) {
  const unwrapped = unwrapExpression(expr);
  if (unwrapped?.type === "Identifier") return unwrapped;
  if (
    unwrapped?.type === "MemberExpression" &&
    unwrapped.object?.type === "Identifier"
  ) {
    return unwrapped.object;
  }
  return null;
}

function hasKnownAnnotation(identifiers) {
  for (const ident of identifiers ?? []) {
    if (
      ident.typeAnnotation &&
      !isUnknownOrAnyAnnotation(ident.typeAnnotation)
    ) {
      return true;
    }
  }
  return false;
}

function constInitOfVariable(binding) {
  const def = binding?.defs?.[0];
  if (def?.type !== "Variable") return null;
  const decl = def.node;
  if (decl?.type !== "VariableDeclarator" || decl.parent?.kind !== "const") {
    return null;
  }
  if (isUnknownOrAnyAnnotation(decl.id?.typeAnnotation)) return null;
  return decl.init ?? null;
}

function hasKnownValueOrigin(sourceCode, expr, seen = new Set()) {
  if (!expr) return false;
  if (isKnownEvidenceExpression(expr)) return !isContractFreeLiteral(expr);
  const rootIdent = rootIdentifierOf(expr);
  if (!rootIdent) return false;
  const binding = findVariable(sourceCode, rootIdent);
  if (!binding || seen.has(binding)) return false;
  seen.add(binding);
  if (hasKnownAnnotation(binding.identifiers)) return true;
  const init = constInitOfVariable(binding);
  return init ? hasKnownValueOrigin(sourceCode, init, seen) : false;
}

function erasedUnknownInitializer(sourceCode, node) {
  if (isAsUnknownExpression(node.init)) {
    const inner = node.init.expression;
    return isContractFreeLiteral(inner) ? null : inner;
  }
  if (node.id?.typeAnnotation?.typeAnnotation?.type === "TSUnknownKeyword") {
    return hasKnownValueOrigin(sourceCode, node.init) ? node.init : null;
  }
  return null;
}

function isContractFreeLiteral(expr) {
  const unwrapped = unwrapExpression(expr);
  return (
    (unwrapped?.type === "ObjectExpression" &&
      unwrapped.properties.length === 0) ||
    (unwrapped?.type === "ArrayExpression" && unwrapped.elements.length === 0)
  );
}

function isReestablishingRef(ident) {
  const parent = ident.parent;
  if (
    parent?.type === "TSAsExpression" &&
    parent.expression === ident &&
    parent.typeAnnotation?.type === "TSTypeReference"
  ) {
    return true;
  }
  if (
    parent?.type === "CallExpression" &&
    parent.arguments[0] === ident &&
    parent.callee?.type === "MemberExpression" &&
    parent.callee.property?.type === "Identifier" &&
    /^(?:parse|safeParse|parseAsync|decodeUnknownSync|decodeUnknownEither)$/u.test(
      parent.callee.property.name
    )
  ) {
    return true;
  }
  return false;
}

export function checkErasedUnknownReparse(node, context) {
  const sourceCode = context.sourceCode;
  if (node.id?.type !== "Identifier" || node.parent?.kind !== "const") return;
  const binding = erasedUnknownInitializer(sourceCode, node)
    ? findVariable(sourceCode, node.id)
    : null;
  if (
    binding?.references.some(
      (ref) => ref.isRead() && isReestablishingRef(ref.identifier)
    )
  ) {
    context.report({
      node: node.id,
      message:
        "Appeasement erasure: widening a known value to `unknown` only makes the parse or cast below look earned. Keep the precise type and validate at the real boundary.",
    });
  }
}

export function checkRedundantSchemaParse(node, context) {
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
