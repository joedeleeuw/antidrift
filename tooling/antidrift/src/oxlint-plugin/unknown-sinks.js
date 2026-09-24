// Positions where `unknown` is the honest annotation for the unknown-input
// rules (`unknown-input-must-be-decoded`, `no-unknown-parameters`):
// rejection-handler parameters, whose value is the promise rejection reason,
// and output parameters whose every read goes straight into a serialization
// sink.

function calledMethodName(call) {
  const callee = call.callee;
  if (callee?.type !== "MemberExpression" || callee.computed) return null;
  const property = callee.property;
  return property?.type === "Identifier" ? property.name : null;
}

// The function itself is a rejection handler: the callback of
// `promise.catch(handler)` or the onRejected argument of
// `promise.then(onFulfilled, handler)`. The fulfillment handler of `then`
// receives a decoded value and is not exempt.
export function isRejectionHandlerFunction(node) {
  const call = node.parent;
  if (call?.type !== "CallExpression" || !call.arguments.includes(node)) {
    return false;
  }
  const method = calledMethodName(call);
  if (method === "catch") return true;
  return method === "then" && call.arguments[1] === node;
}

// Serialization sinks, narrowly: the serialized-value (first) argument of
// `JSON.stringify(value)` or `Response.json(value)`. Serializing an output
// accepts every value by design, so it proves no contract and requires none.
const SERIALIZATION_SINKS = new Map([
  ["JSON", new Set(["stringify"])],
  ["Response", new Set(["json"])],
]);

export function isSerializerSinkUse(identifier) {
  const call = identifier.parent;
  if (call?.type !== "CallExpression" || call.arguments[0] !== identifier) {
    return false;
  }
  const method = calledMethodName(call);
  const object = call.callee.object;
  return (
    object?.type === "Identifier" &&
    SERIALIZATION_SINKS.get(object.name)?.has(method) === true
  );
}
