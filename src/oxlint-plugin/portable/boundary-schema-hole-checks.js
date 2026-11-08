import {
  hasRuntimeSchemaProvenance,
  hasZodSchemaProvenance,
  resolveSchemaBuilderCall,
} from "../shared/runtime-schema-libraries.js";
import {
  constInitializer,
  findVariable,
  isFunctionLike,
  staticPropertyKey,
  unwrapExpression,
} from "../shared/scope.js";
import { SCHEMA_DECODE_METHODS } from "./boundary-decode-checks.js";

const BASE_ERROR_SCHEMA_KEYS = new Set(["name", "message", "stack", "cause"]);

function isBaseErrorObjectSchema(schemaExpr, sourceCode) {
  const target =
    schemaExpr?.type === "Identifier"
      ? (constInitializer(sourceCode, schemaExpr) ?? schemaExpr)
      : schemaExpr;
  const builder = resolveSchemaBuilderCall(target, sourceCode);
  if (builder?.method !== "object") return false;
  const shapeArg = unwrapExpression(builder.args[0]);
  if (
    shapeArg?.type !== "ObjectExpression" ||
    shapeArg.properties.length === 0
  ) {
    return false;
  }
  return shapeArg.properties.every((prop) => {
    const key = staticPropertyKey(prop);
    return key !== null && BASE_ERROR_SCHEMA_KEYS.has(key);
  });
}

function isNegatedErrorInstanceofTest(testNode, paramName) {
  if (!testNode) return false;
  if (testNode.type === "UnaryExpression" && testNode.operator === "!") {
    const arg = unwrapExpression(testNode.argument);
    return (
      arg?.type === "BinaryExpression" &&
      arg.operator === "instanceof" &&
      arg.left?.type === "Identifier" &&
      arg.left.name === paramName &&
      arg.right?.type === "Identifier" &&
      arg.right.name === "Error"
    );
  }
  if (testNode.type === "LogicalExpression" && testNode.operator === "||") {
    return (
      isNegatedErrorInstanceofTest(testNode.left, paramName) ||
      isNegatedErrorInstanceofTest(testNode.right, paramName)
    );
  }
  return false;
}

function statementExitsEarly(stmt) {
  if (!stmt) return false;
  if (stmt.type === "ReturnStatement" || stmt.type === "ThrowStatement") {
    return true;
  }
  return (
    stmt.type === "BlockStatement" &&
    stmt.body.length > 0 &&
    statementExitsEarly(stmt.body.at(-1))
  );
}

function hasDominatingErrorInstanceofGuard(node, paramName) {
  for (let cur = node; cur; cur = cur.parent) {
    if (cur.parent?.type === "BlockStatement") {
      const statements = cur.parent.body;
      const idx = statements.indexOf(cur);
      for (let i = 0; i < idx; i++) {
        const stmt = statements[i];
        if (
          stmt?.type === "IfStatement" &&
          statementExitsEarly(stmt.consequent) &&
          isNegatedErrorInstanceofTest(stmt.test, paramName)
        ) {
          return true;
        }
      }
    }
    if (isFunctionLike(cur)) break;
  }
  return false;
}

export function checkCatchClauseSchemaDecode(node, context) {
  const sourceCode = context.sourceCode;
  const callee = unwrapExpression(node.callee);
  const arg = unwrapExpression(node.arguments?.[0]);
  if (
    callee?.type !== "MemberExpression" ||
    callee.computed ||
    node.arguments.length !== 1 ||
    !SCHEMA_DECODE_METHODS.has(callee.property?.name) ||
    !hasRuntimeSchemaProvenance(callee.object, sourceCode) ||
    arg?.type !== "Identifier"
  ) {
    return;
  }
  const binding = findVariable(sourceCode, arg);
  const defType = binding?.defs?.[0]?.type;
  if (defType === "CatchClause") {
    context.report({
      node,
      message: `Do not decode caught exception '${arg.name}' with a boundary schema; narrow with \`instanceof Error\` (and \`'code' in ${arg.name}\`) or handle expected exit statuses at the process boundary.`,
    });
  } else if (
    defType === "Parameter" &&
    hasDominatingErrorInstanceofGuard(node, arg.name) &&
    isBaseErrorObjectSchema(callee.object, sourceCode)
  ) {
    context.report({
      node,
      message: `Do not decode \`instanceof Error\`-narrowed parameter '${arg.name}' with a base Error schema; inspect structured properties on the narrowed instance directly.`,
    });
  }
}

function unvalidatedSchemaBranchMethod(expression, sourceCode) {
  const node = unwrapExpression(expression);
  const builder = resolveSchemaBuilderCall(node, sourceCode);
  if (!builder) return null;
  if (
    (builder.method === "unknown" ||
      builder.method === "any" ||
      builder.method === "custom") &&
    builder.args.length === 0
  ) {
    return builder.method;
  }
  return null;
}

function isUnionBranchTransform(node, sourceCode) {
  let current = node.parent;
  while (
    current?.type === "CallExpression" &&
    current.callee?.type === "MemberExpression" &&
    /^(?:nullish|nullable|optional|readonly)$/u.test(
      current.callee.property?.name ?? ""
    )
  ) {
    current = current.parent;
  }
  if (current?.type === "ArrayExpression") {
    const parentCall = current.parent;
    const unionBuilder = resolveSchemaBuilderCall(parentCall, sourceCode);
    return unionBuilder?.method === "union";
  }
  if (current?.type === "CallExpression") {
    const orBuilder = resolveSchemaBuilderCall(current, sourceCode);
    return orBuilder?.method === "or";
  }
  return false;
}

function checkUnionSchemaWidening(node, builder, context) {
  const sourceCode = context.sourceCode;
  if (
    builder.method === "union" &&
    builder.args[0]?.type === "ArrayExpression" &&
    builder.args[0].elements.length >= 2
  ) {
    const holeBranch = builder.args[0].elements.find((element) =>
      Boolean(unvalidatedSchemaBranchMethod(element, sourceCode))
    );
    const holeMethod =
      holeBranch && unvalidatedSchemaBranchMethod(holeBranch, sourceCode);
    if (holeBranch && holeMethod) {
      context.report({
        node: holeBranch,
        message: `Do not include \`z.${holeMethod}()\` as a branch of \`z.union([...])\`; an unvalidated branch absorbs every validation failure and widens the union to untyped input.`,
      });
    }
    return;
  }
  if (builder.method === "or" && node.callee?.type === "MemberExpression") {
    const holeMethod =
      unvalidatedSchemaBranchMethod(builder.args[0], sourceCode) ??
      unvalidatedSchemaBranchMethod(node.callee.object, sourceCode);
    if (holeMethod) {
      context.report({
        node,
        message: `Do not combine a typed schema with \`z.${holeMethod}()\` via \`.or()\`; an unvalidated branch absorbs every validation failure and widens the schema to untyped input.`,
      });
    }
  }
}

export function checkUnvalidatedSchemaHole(node, context) {
  const sourceCode = context.sourceCode;
  if (!hasZodSchemaProvenance(node, sourceCode)) return;
  const builder = resolveSchemaBuilderCall(node, sourceCode);
  if (!builder) return;
  if (builder.method === "any" && builder.args.length === 0) {
    context.report({
      node,
      message:
        "Do not use `z.any()` in a boundary schema; validate the expected shape or use `z.unknown()` when the payload is intentionally opaque.",
    });
    return;
  }
  if (builder.method === "custom" && builder.args.length === 0) {
    context.report({
      node,
      message:
        "Do not call `z.custom()` without a validation predicate; bare `z.custom<T>()` accepts any value at runtime like an unchecked `as T` cast.",
    });
    return;
  }
  if (
    builder.method === "transform" &&
    node.callee?.type === "MemberExpression" &&
    !isUnionBranchTransform(node, sourceCode)
  ) {
    const receiverBuilder = resolveSchemaBuilderCall(
      node.callee.object,
      sourceCode
    );
    if (
      receiverBuilder?.method === "unknown" ||
      receiverBuilder?.method === "any"
    ) {
      context.report({
        node,
        message: `Do not chain \`.transform()\` directly on \`z.${receiverBuilder.method}()\`; validate the input schema before transforming or call a plain function instead of wrapping it in a no-op schema.`,
      });
      return;
    }
  }
  checkUnionSchemaWidening(node, builder, context);
}

const SPLIT_CHAIN_STEPS = new Set([
  "filter",
  "slice",
  "trim",
  "flatMap",
  "map",
]);
const NUMERIC_COERCERS = new Set(["Number", "parseInt", "parseFloat"]);

function isSplitStringReceiver(expression) {
  let current = unwrapExpression(expression);
  while (
    current?.type === "CallExpression" &&
    current.callee?.type === "MemberExpression" &&
    !current.callee.computed &&
    current.callee.property?.type === "Identifier"
  ) {
    const method = current.callee.property.name;
    if (method === "split") return true;
    if (!SPLIT_CHAIN_STEPS.has(method)) return false;
    current = unwrapExpression(current.callee.object);
  }
  return false;
}

function isTupleDestructuredOrGuarded(mapCallNode, sourceCode) {
  if (
    mapCallNode.parent?.type === "VariableDeclarator" &&
    mapCallNode.parent.id?.type === "ArrayPattern"
  ) {
    return true;
  }
  for (let cur = mapCallNode.parent; cur; cur = cur.parent) {
    if (isFunctionLike(cur) || cur.type === "Program") {
      const target = cur.type === "Program" ? cur : cur.body;
      return /\b(?:isFinite|isInteger|isNaN)\b/u.test(
        sourceCode.getText(target)
      );
    }
  }
  return false;
}

function numericCoercerName(callee) {
  const target = unwrapExpression(callee);
  if (target?.type === "Identifier" && NUMERIC_COERCERS.has(target.name)) {
    return target.name;
  }
  if (
    target?.type === "MemberExpression" &&
    !target.computed &&
    target.object?.type === "Identifier" &&
    target.object.name === "Number" &&
    (target.property?.name === "parseInt" ||
      target.property?.name === "parseFloat")
  ) {
    return `Number.${target.property.name}`;
  }
  return null;
}

function passesCallbackParam(argNode, paramName) {
  const firstArg = unwrapExpression(argNode);
  if (firstArg?.type === "Identifier") return firstArg.name === paramName;
  return (
    firstArg?.type === "CallExpression" &&
    firstArg.callee?.type === "MemberExpression" &&
    firstArg.callee.object?.type === "Identifier" &&
    firstArg.callee.object.name === paramName &&
    firstArg.callee.property?.name === "trim"
  );
}

function callbackNumericCoercer(callbackNode) {
  const callback = unwrapExpression(callbackNode);
  const directCoercer = numericCoercerName(callback);
  if (directCoercer) return directCoercer;
  if (!isFunctionLike(callback) || callback.params[0]?.type !== "Identifier") {
    return null;
  }
  const paramName = callback.params[0].name;
  const bodyExpr =
    callback.body?.type === "BlockStatement" &&
    callback.body.body.length === 1 &&
    callback.body.body[0].type === "ReturnStatement"
      ? unwrapExpression(callback.body.body[0].argument)
      : unwrapExpression(callback.body);
  if (bodyExpr?.type !== "CallExpression") return null;
  return passesCallbackParam(bodyExpr.arguments[0], paramName)
    ? numericCoercerName(bodyExpr.callee)
    : null;
}

export function checkUncheckedSplitNumericCoercion(node, context) {
  if (
    node.callee?.type !== "MemberExpression" ||
    node.callee.computed ||
    node.callee.property?.name !== "map" ||
    node.arguments.length === 0 ||
    !isSplitStringReceiver(node.callee.object)
  ) {
    return;
  }
  const callbackArg = unwrapExpression(node.arguments[0]);
  const isBareParseIntCallback =
    (callbackArg?.type === "Identifier" && callbackArg.name === "parseInt") ||
    (callbackArg?.type === "MemberExpression" &&
      numericCoercerName(callbackArg) === "Number.parseInt");
  if (
    !isBareParseIntCallback &&
    isTupleDestructuredOrGuarded(node, context.sourceCode)
  ) {
    return;
  }
  const coercer = callbackNumericCoercer(node.arguments[0]);
  if (coercer) {
    context.report({
      node,
      message: `Do not coerce split string tokens with unchecked \`${coercer}(...)\` in \`.map()\` (which silently produces \`NaN\` on non-numeric output); validate numeric tokens explicitly or decode with a boundary schema.`,
    });
  }
}
