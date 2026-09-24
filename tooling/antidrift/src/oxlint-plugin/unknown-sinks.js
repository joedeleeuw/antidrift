// Positions where `unknown` is the honest annotation for the unknown-input
// rules (`unknown-input-must-be-decoded`, `no-unknown-parameters`):
// rejection-handler parameters, whose value is the promise rejection reason,
// and output parameters whose every read goes straight into a serialization
// sink. Both exemptions require names to resolve to unshadowed globals, so a
// local binding that reuses a global's name is still checked.

import { findVariable } from "../semantic-adapters/async-control-flow.mjs";

function calledMethodName(call) {
  const callee = call.callee;
  if (callee?.type !== "MemberExpression" || callee.computed) return null;
  const property = callee.property;
  return property?.type === "Identifier" ? property.name : null;
}

// An identifier names an unshadowed global when lexical resolution finds no
// variable at all, or a variable with no definitions (an ambient global).
// Parameters, locals, and imports that reuse a global's name have
// definitions and do not qualify.
export function isUnshadowedGlobal(sourceCode, identifier) {
  if (identifier?.type !== "Identifier") return false;
  const variable = findVariable(sourceCode, identifier);
  return !variable || (variable.defs?.length ?? 0) === 0;
}

function isRejectionHandlerArgument(node) {
  const call = node.parent;
  if (call?.type !== "CallExpression" || !call.arguments.includes(node)) {
    return false;
  }
  const method = calledMethodName(call);
  if (method === "catch") return true;
  return method === "then" && call.arguments[1] === node;
}

function definedName(node) {
  if (node.type === "FunctionDeclaration" && node.id) return node.id;
  if (
    (node.type === "ArrowFunctionExpression" ||
      node.type === "FunctionExpression") &&
    node.parent?.type === "VariableDeclarator" &&
    node.parent.id.type === "Identifier"
  ) {
    return node.parent.id;
  }
  return null;
}

// The function is a rejection handler: the callback of
// `promise.catch(handler)` or the onRejected argument of
// `promise.then(onFulfilled, handler)`. An inline function is only ever in
// that position; a named function (`promise.catch(onError)`) matches the same
// way, so every read of its name must be a rejection position — a name also
// called directly is shared code, not a rejection handler. The fulfillment
// handler of `then` receives a decoded value and is not exempt.
export function isRejectionHandlerFunction(node, sourceCode) {
  if (isRejectionHandlerArgument(node)) return true;
  const name = definedName(node);
  if (!name) return false;
  const variable = findVariable(sourceCode, name);
  if (!variable) return false;
  const reads = variable.references.filter(
    (reference) => reference.isRead() && !reference.isTypeReference,
  );
  return (
    reads.length > 0 &&
    reads.every((reference) => isRejectionHandlerArgument(reference.identifier))
  );
}

// The binding position that owns this annotation, climbing through default
// values, rest markers, and constructor parameter properties.
export function owningBinding(node) {
  let binding = node;
  while (
    ["AssignmentPattern", "TSParameterProperty", "RestElement"].includes(
      binding.parent.type,
    )
  ) {
    binding = binding.parent;
  }
  return binding;
}

// The identifier is a constructor parameter property (`constructor(private
// body: unknown)`), walking through default values and rest markers.
// Parameter properties are never exempt: `this.body` reads are not parameter
// references, so no read analysis can cover them.
export function isParameterProperty(node) {
  return owningBinding(node).type === "TSParameterProperty";
}

// The parameter's underlying declared identifier, through default values and
// rest markers. Patterns and parameter properties have no single identifier.
export function parameterIdentifier(parameter) {
  let current = parameter;
  if (current?.type === "AssignmentPattern") current = current.left;
  if (current?.type === "RestElement") current = current.argument;
  return current?.type === "Identifier" ? current : null;
}

// Serialization sinks, narrowly: the serialized-value (first) argument of
// `JSON.stringify(value)` or `Response.json(value)`. Serializing an output
// accepts every value by design, so it proves no contract and requires none.
const SERIALIZATION_SINKS = new Map([
  ["JSON", new Set(["stringify"])],
  ["Response", new Set(["json"])],
]);

function sinkResultEscape(call) {
  let result = call.parent;
  if (result?.type === "ChainExpression") result = result.parent;
  // `Response.json(value).json()`: drilling into the sink result.
  if (result?.type === "MemberExpression" && result.object === call) {
    return true;
  }
  // `JSON.parse(JSON.stringify(value))`: laundering unknown into any.
  return (
    result?.type === "CallExpression" &&
    result.arguments.includes(call) &&
    result.callee?.type === "MemberExpression" &&
    !result.callee.computed &&
    result.callee.object?.type === "Identifier" &&
    result.callee.object.name === "JSON" &&
    calledMethodName(result) === "parse"
  );
}

export function isSerializerSinkUse(sourceCode, identifier) {
  const call = identifier.parent;
  if (call?.type !== "CallExpression" || call.arguments[0] !== identifier) {
    return false;
  }
  const callee = call.callee;
  if (callee?.type !== "MemberExpression" || callee.computed) return false;
  const object = callee.object;
  if (
    object?.type !== "Identifier" ||
    SERIALIZATION_SINKS.get(object.name)?.has(calledMethodName(call)) !== true
  ) {
    return false;
  }
  // A function-valued second argument (a JSON.stringify replacer) receives
  // pieces of the value as `any`: that is transformation, not pure
  // serialization.
  const modifier = call.arguments[1];
  if (
    modifier?.type === "FunctionExpression" ||
    modifier?.type === "ArrowFunctionExpression"
  ) {
    return false;
  }
  return (
    isUnshadowedGlobal(sourceCode, object) && !sinkResultEscape(call)
  );
}

// A variable is a sink-only output when it is read at least once, never
// reassigned, and every read hands the value to a serialization sink. Unused
// variables, writes, and any other read keep the annotation reported.
export function variableReadsOnlySinks(sourceCode, variable) {
  if (!variable) return false;
  if (
    variable.references.some(
      (reference) => reference.isWrite() && !reference.init,
    )
  ) {
    return false;
  }
  const reads = variable.references.filter(
    (reference) => reference.isRead() && !reference.isTypeReference,
  );
  return (
    reads.length > 0 &&
    reads.every((reference) =>
      isSerializerSinkUse(sourceCode, reference.identifier),
    )
  );
}

// A read that inspects an unknown rejection reason instead of forwarding it:
// an assertion (`as`, `!`, angle-bracket casts), member access, a `typeof`
// operand, or the right side of `in`. Forwarding reads — call arguments,
// `throw`, and `cause:` properties — stay allowed, as do `instanceof`
// discriminations and other reads outside this list.
export function isErrorInspectionRead(identifier) {
  const parent = identifier.parent;
  switch (parent.type) {
    case "TSAsExpression":
    case "TSTypeAssertion":
    case "TSNonNullExpression":
    case "MemberExpression":
      return true;
    case "UnaryExpression":
      return parent.operator === "typeof";
    case "BinaryExpression":
      return parent.operator === "in" && parent.right === identifier;
    default:
      return false;
  }
}
