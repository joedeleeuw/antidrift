import { hasRuntimeSchemaProvenance } from "../shared/runtime-schema-libraries.js";
import {
  findVariable,
  isFunctionLike,
  unwrapExpression,
} from "../shared/scope.js";

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

function matchesInferredParameterSchema(def, schemaText, sourceCode) {
  if (def.type !== "Parameter") return false;
  const ann = def.name?.typeAnnotation?.typeAnnotation;
  if (
    ann?.type !== "TSTypeReference" ||
    ann.typeName?.type !== "TSQualifiedName"
  ) {
    return false;
  }
  const rightName = ann.typeName.right?.name;
  if (rightName !== "infer" && rightName !== "output") return false;
  const typeArg = ann.typeArguments?.params?.[0];
  if (typeArg?.type !== "TSTypeQuery" || !typeArg.exprName) return false;
  return (
    sourceCode.getText(typeArg.exprName).replace(/\s+/gu, "") === schemaText
  );
}

function isSchemaReceiver(expression, sourceCode) {
  if (hasRuntimeSchemaProvenance(expression, sourceCode)) return true;
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
  }
  if (matchesInferredParameterSchema(def, schemaText, sourceCode)) {
    context.report({
      node,
      message: `Parameter '${arg.name}' is already typed as a decoded schema output; do not re-parse internal typed values.`,
    });
  }
}

export function checkRedundantSchemaParse(node, context) {
  const sourceCode = context.sourceCode;
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
