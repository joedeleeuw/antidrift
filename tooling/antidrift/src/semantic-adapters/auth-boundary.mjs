export const DEFAULT_AUTHZ_FUNCTIONS = Object.freeze([
  "requireUser",
  "authorize",
  "requireTenant",
  "can",
  "assertCan",
  "checkAccess",
  "requireRole",
  "ensureCan",
]);

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

export function isAuthzCall(callee, authzFunctions = DEFAULT_AUTHZ_FUNCTIONS) {
  const name = callExpressionName(callee);
  return Boolean(name && new Set(authzFunctions).has(name));
}

export function createAuthBoundaryTracker(options = {}) {
  const authzFunctions = options.authzFunctions ?? DEFAULT_AUTHZ_FUNCTIONS;
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
