export const REQUEST_PARAM_ROOTS = Object.freeze([
  "req",
  "request",
  "ctx",
  "context",
  "event",
]);

export function callExpressionName(callee) {
  if (callee?.type === "Identifier") return callee.name;
  if (
    callee?.type === "MemberExpression" &&
    callee.property?.type === "Identifier"
  ) {
    return callee.property.name;
  }
  return null;
}

function requireStringList(name, values) {
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    values.some((value) => typeof value !== "string" || value.length === 0)
  ) {
    throw new Error(`auth-boundary: ${name} must be a non-empty string array`);
  }
  return values;
}

export function isRequestParamsAccess(
  node,
  requestParamRoots = REQUEST_PARAM_ROOTS,
) {
  const roots = new Set(requestParamRoots);
  return Boolean(
    node?.property?.type === "Identifier" &&
    node.property.name === "params" &&
    node.object?.type === "Identifier" &&
    roots.has(node.object.name),
  );
}

export function isAuthzCall(callee, authzFunctions) {
  const functions = requireStringList("authzFunctions", authzFunctions);
  const name = callExpressionName(callee);
  return Boolean(name && new Set(functions).has(name));
}

export function createAuthBoundaryTracker(options = {}) {
  const authzFunctions = requireStringList(
    "authzFunctions",
    options.authzFunctions,
  );
  const requestParamRoots = options.requestParamRoots ?? REQUEST_PARAM_ROOTS;
  const onFrameExit = options.onFrameExit ?? (() => {});
  const stack = [];

  function enter(node) {
    stack.push({ node, paramsAccess: null, sawAuthz: false });
  }

  function exit() {
    const frame = stack.pop();
    if (frame) onFrameExit(frame);
  }

  return {
    visitors: {
      FunctionDeclaration: enter,
      "FunctionDeclaration:exit": exit,
      FunctionExpression: enter,
      "FunctionExpression:exit": exit,
      ArrowFunctionExpression: enter,
      "ArrowFunctionExpression:exit": exit,
      MemberExpression(node) {
        if (stack.length === 0) return;
        if (isRequestParamsAccess(node, requestParamRoots)) {
          stack[stack.length - 1].paramsAccess = node;
        }
      },
      CallExpression(node) {
        if (stack.length === 0) return;
        if (isAuthzCall(node.callee, authzFunctions)) {
          stack[stack.length - 1].sawAuthz = true;
        }
      },
    },
  };
}
