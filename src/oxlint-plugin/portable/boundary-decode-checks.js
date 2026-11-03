import {
  hasRuntimeSchemaProvenance,
  schemaReceiverVerdict,
} from "../shared/runtime-schema-libraries.js";
import {
  constInitializer,
  findVariable,
  isFunctionLike,
  staticPropertyName,
  unwrapAwaitedExpression,
  unwrapExpression,
} from "../shared/scope.js";
import {
  closedStringLiteralUnionValues,
  hasTypeChecker,
  isBroadResolvedType,
  resolvedPropertyShape,
} from "../shared/type-services.js";

const SCHEMA_DECODE_METHODS = new Set([
  "parse",
  "safeParse",
  "parseAsync",
  "safeParseAsync",
  "decodeUnknownSync",
  "decodeUnknownEither",
  "decodeUnknownPromise",
  "decodeSync",
]);
const VALUE_RETURNING_DECODE_METHODS = new Set([
  "parse",
  "parseAsync",
  "decodeUnknownSync",
  "decodeSync",
]);

export const RAW_DESERIALIZE_CAST_MESSAGE =
  "Do not cast raw deserialized JSON directly to a domain type; decode once at the boundary with a schema validator.";

export function isJsonCall(node, method) {
  const callee = unwrapExpression(node?.callee);
  return (
    node?.type === "CallExpression" &&
    callee?.type === "MemberExpression" &&
    !callee.computed &&
    callee.object?.type === "Identifier" &&
    callee.object.name === "JSON" &&
    callee.property?.name === method
  );
}

export function isRawDeserializeCall(node) {
  const expr = unwrapAwaitedExpression(node);
  if (expr?.type !== "CallExpression") return false;
  const callee = unwrapExpression(expr.callee);
  if (
    callee?.type !== "MemberExpression" ||
    callee.computed ||
    callee.property?.type !== "Identifier" ||
    callee.object?.type !== "Identifier"
  ) {
    return false;
  }
  if (
    callee.property.name === "parse" &&
    /^(?:JSON|YAML)$/u.test(callee.object.name)
  ) {
    return true;
  }
  return (
    callee.property.name === "json" &&
    /^(?:res|response|req|request)$/iu.test(callee.object.name)
  );
}

export function isPassedToDecoder(node, sourceCode) {
  const parent = node.parent;
  if (parent?.type !== "CallExpression" || !parent.arguments.includes(node)) {
    return false;
  }
  const callee = unwrapExpression(parent.callee);
  if (callee?.type === "Identifier") return true;
  if (
    callee?.type !== "MemberExpression" ||
    callee.property?.type !== "Identifier" ||
    !SCHEMA_DECODE_METHODS.has(callee.property.name) ||
    (callee.object?.type === "Identifier" && callee.object.name === "JSON")
  ) {
    return false;
  }
  return schemaReceiverVerdict(callee.object, sourceCode) !== "disproven";
}

export function isAliasedRawDeserialize(expression, sourceCode) {
  const identifier = unwrapExpression(expression);
  if (identifier?.type !== "Identifier") return false;
  const binding = findVariable(sourceCode, identifier);
  const declarator = binding?.defs?.[0]?.node;
  return Boolean(
    declarator?.type === "VariableDeclarator" &&
    !declarator.id.typeAnnotation &&
    isRawDeserializeCall(constInitializer(sourceCode, identifier)) &&
    !binding.references.some((ref) =>
      isPassedToDecoder(ref.identifier, sourceCode)
    )
  );
}

export function checkRepairOnReadTernary(node, context) {
  const sourceCode = context.sourceCode;
  const test = unwrapExpression(node.test);
  if (test?.type !== "BinaryExpression" || !/^[!=]==$/u.test(test.operator)) {
    return;
  }
  const typeofSide = [test.left, test.right].find(
    (side) => side.type === "UnaryExpression" && side.operator === "typeof"
  );
  const literalSide = test.left === typeofSide ? test.right : test.left;
  if (!typeofSide || literalSide.value !== "string") return;
  const subject = sourceCode.getText(typeofSide.argument);
  const [parsed, passthrough] =
    test.operator === "==="
      ? [node.consequent, node.alternate]
      : [node.alternate, node.consequent];
  const parseCall = unwrapExpression(parsed);
  if (
    isJsonCall(parseCall, "parse") &&
    parseCall.arguments[0] &&
    sourceCode.getText(parseCall.arguments[0]) === subject &&
    sourceCode.getText(unwrapExpression(passthrough)) === subject
  ) {
    context.report({
      node,
      message: `'${subject}' is repaired on read as string-or-object JSON; decode it once at the boundary into one typed shape instead of branching on \`typeof\`.`,
    });
  }
}

export function checkSerializationRoundtrip(node, context) {
  if (isJsonCall(node, "parse") && isJsonCall(node.arguments[0], "stringify")) {
    context.report({
      node,
      message:
        "Do not round-trip in-memory values through `JSON.stringify(...)` and `JSON.parse(...)`; clone with `structuredClone(...)` or key by a structured tuple/value.",
    });
  }
}

function decodedBlobOrigin(identifier, sourceCode) {
  let init = unwrapAwaitedExpression(constInitializer(sourceCode, identifier));
  if (!isJsonCall(init, "parse") && init?.arguments?.length === 1) {
    init = unwrapAwaitedExpression(init.arguments[0]);
  }
  const blob = isJsonCall(init, "parse")
    ? unwrapExpression(init.arguments[0])
    : null;
  return blob?.type === "MemberExpression" &&
    !blob.computed &&
    blob.object?.type === "Identifier"
    ? { carrier: blob.object.name, blobField: blob.property.name }
    : null;
}

function plainMember(node) {
  const member = unwrapExpression(node);
  return member?.type === "MemberExpression" &&
    !member.computed &&
    member.object?.type === "Identifier"
    ? member
    : null;
}

export function checkDecodedBlobEquality(node, context) {
  if (node.operator !== "===" && node.operator !== "!==") return;
  const left = plainMember(node.left);
  const right = plainMember(node.right);
  if (!left || !right || left.property.name !== right.property.name) return;
  for (const [decoded, sibling] of [
    [left, right],
    [right, left],
  ]) {
    const origin = decodedBlobOrigin(decoded.object, context.sourceCode);
    if (
      origin?.carrier === sibling.object.name &&
      origin.blobField !== sibling.property.name
    ) {
      const field = decoded.property.name;
      context.report({
        node,
        message: `Decoded blob field '${field}' is compared against sibling property '${origin.carrier}.${field}' on the same record; keep one canonical owner instead of duplicating columns beside '${origin.carrier}.${origin.blobField}'.`,
      });
      return;
    }
  }
}

export function checkDiscardedDecode(node, context) {
  const sourceCode = context.sourceCode;
  const call = unwrapAwaitedExpression(node.expression);
  const callee = unwrapExpression(call?.callee);
  const argument = unwrapExpression(call?.arguments?.[0]);
  if (
    callee?.type !== "MemberExpression" ||
    callee.computed ||
    call.arguments.length !== 1 ||
    argument?.type !== "Identifier" ||
    !VALUE_RETURNING_DECODE_METHODS.has(callee.property?.name) ||
    !hasRuntimeSchemaProvenance(callee.object, sourceCode)
  ) {
    return;
  }
  const statementScope = sourceCode.getScope(node).variableScope;
  const readLater = findVariable(sourceCode, argument)?.references.some(
    (ref) =>
      ref.isRead() &&
      ref.from.variableScope === statementScope &&
      ref.identifier.range[0] > node.range[1]
  );
  if (readLater) {
    context.report({
      node,
      message: `Decode result of '${sourceCode.getText(callee.object)}.${callee.property.name}(${argument.name})' is discarded while raw '${argument.name}' is used afterwards; bind the decoded value and use it instead.`,
    });
  }
}

export function checkPositionalOptions(node, context) {
  if (
    node.computed ||
    node.property?.name !== "options" ||
    !hasRuntimeSchemaProvenance(node.object, context.sourceCode)
  ) {
    return;
  }
  const parent = node.parent;
  const destructured =
    parent?.type === "VariableDeclarator" &&
    parent.init === node &&
    parent.id.type === "ArrayPattern" &&
    parent.id.elements.length >= 2;
  const indexed =
    parent?.type === "MemberExpression" &&
    parent.object === node &&
    parent.computed &&
    typeof parent.property?.value === "number";
  if (destructured || indexed) {
    context.report({
      node: parent,
      message:
        "Do not read schema `.options` by position; positions silently re-bind when members are reordered. Reference each member by its literal value instead.",
    });
  }
}

function isLiteralUnionType(typeNode) {
  return (
    typeNode?.type === "TSUnionType" &&
    typeNode.types.every(
      (member) =>
        member.type === "TSLiteralType" &&
        typeof member.literal?.value === "string"
    )
  );
}

function isClosedLiteralCast(node, sourceCode) {
  if (isLiteralUnionType(node.typeAnnotation)) return true;
  if (!hasTypeChecker(sourceCode)) return false;
  const literalMembers = closedStringLiteralUnionValues(
    node.typeAnnotation,
    sourceCode
  );
  return (
    (literalMembers?.length ?? 0) >= 2 &&
    closedStringLiteralUnionValues(node.expression, sourceCode) === null
  );
}

function isOwnedParameterReference(expression, sourceCode) {
  const identifier = unwrapExpression(expression);
  const definition =
    identifier?.type === "Identifier"
      ? findVariable(sourceCode, identifier)?.defs?.[0]
      : null;
  return (
    definition?.type === "Parameter" &&
    (definition.name?.typeAnnotation?.typeAnnotation?.type ===
      "TSUnknownKeyword" ||
      definition.node?.returnType?.typeAnnotation?.type === "TSTypePredicate")
  );
}

function isBroadStructuredCast(node, sourceCode) {
  const target = node.typeAnnotation;
  return (
    hasTypeChecker(sourceCode) &&
    !(target?.type ?? "").endsWith("Keyword") &&
    !isRawDeserializeCall(node.expression) &&
    !isAliasedRawDeserialize(node.expression, sourceCode) &&
    !isOwnedParameterReference(node.expression, sourceCode) &&
    isBroadResolvedType(node.expression, sourceCode) &&
    (resolvedPropertyShape(target, sourceCode)?.all.length ?? 0) > 0
  );
}

export function checkUndecodedCast(node, context) {
  const sourceCode = context.sourceCode;
  if (
    node.expression?.type !== "Literal" &&
    isClosedLiteralCast(node, sourceCode)
  ) {
    context.report({
      node,
      message:
        "Do not cast a value to a closed string-literal union; check membership against the owned values (a schema enum or an `includes` guard) instead.",
    });
  } else if (isBroadStructuredCast(node, sourceCode)) {
    context.report({
      node,
      message:
        "Do not cast a broad `any`/`unknown`/generic value to a structured contract; decode it at the boundary or narrow it with a checked guard.",
    });
  }
}

const UNKNOWN_ERROR_HELPERS = new Set([
  "errorFromUnknown",
  "toError",
  "normalizeError",
]);

function isKnownError(expression, sourceCode, depth = 0) {
  const node = unwrapExpression(expression);
  if (node?.type === "NewExpression") {
    return (node.callee?.name ?? "").endsWith("Error");
  }
  if (node?.type !== "Identifier" || depth > 4) return false;
  const definition = findVariable(sourceCode, node)?.defs?.[0];
  const annotation = definition?.name?.typeAnnotation?.typeAnnotation;
  if (annotation?.type === "TSTypeReference") {
    return (annotation.typeName?.name ?? "").endsWith("Error");
  }
  const init = constInitializer(sourceCode, node);
  return init ? isKnownError(init, sourceCode, depth + 1) : false;
}

export function checkRedundantUnknownHelper(node, context) {
  const callee = unwrapExpression(node.callee);
  const name =
    callee?.type === "Identifier" ? callee.name : staticPropertyName(callee);
  if (
    UNKNOWN_ERROR_HELPERS.has(name) &&
    node.arguments.length === 1 &&
    isKnownError(node.arguments[0], context.sourceCode)
  ) {
    context.report({
      node,
      message: `'${name}' normalizes unknown values, but '${context.sourceCode.getText(node.arguments[0])}' is already an Error; pass it through directly.`,
    });
  }
}

function isFallbackLiteral(node) {
  return (
    node?.type === "Literal" ||
    node?.type === "ArrayExpression" ||
    node?.type === "ObjectExpression"
  );
}

function collectFallbackReturns(node, sourceCode, returns) {
  if (!node || isFunctionLike(node)) return true;
  if (node.type === "ThrowStatement") return false;
  if (node.type === "ReturnStatement") {
    returns.push(unwrapExpression(node.argument));
  }
  return (sourceCode.visitorKeys[node.type] ?? []).every((key) => {
    const children = Array.isArray(node[key]) ? node[key] : [node[key]];
    return children.every((child) =>
      collectFallbackReturns(child, sourceCode, returns)
    );
  });
}

function isSilentFallback(expression, sourceCode) {
  const fallback = unwrapExpression(expression);
  if (isFallbackLiteral(fallback)) return true;
  if (!isFunctionLike(fallback)) return false;
  if (isFallbackLiteral(unwrapExpression(fallback.body))) return true;
  const returns = [];
  return (
    collectFallbackReturns(fallback.body, sourceCode, returns) &&
    returns.length > 0 &&
    returns.every(isFallbackLiteral)
  );
}

function enclosingObjectLiteral(node) {
  for (let cur = node.parent; cur && !isFunctionLike(cur); cur = cur.parent) {
    if (cur.type === "ObjectExpression") return cur;
  }
  return null;
}

export function checkSchemaCatch(node, reportedObjects, context) {
  const callee = node.callee;
  if (
    callee?.type === "MemberExpression" &&
    !callee.computed &&
    callee.property?.name === "catch" &&
    hasRuntimeSchemaProvenance(callee.object, context.sourceCode) &&
    isSilentFallback(node.arguments[0], context.sourceCode)
  ) {
    const objectLiteral = enclosingObjectLiteral(node);
    if (objectLiteral) {
      if (reportedObjects.has(objectLiteral)) return;
      reportedObjects.add(objectLiteral);
    }
    context.report({
      node,
      message:
        "Schema `.catch(fallback)` silently repairs invalid boundary input on read; reject invalid input instead.",
    });
  }
}
