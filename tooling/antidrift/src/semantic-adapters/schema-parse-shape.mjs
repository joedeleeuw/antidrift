// Syntax-only facts about Zod validation calls. Nothing here touches a
// TypeScript program, so the Oxlint tier can load it without pulling the
// compiler into the fast path. `schema-provenance.mjs` re-exports the shared
// names so the type-aware rules keep their existing import surface.

export const ZOD_PARSE_METHODS = new Set(["parse", "parseAsync"]);
export const ZOD_SAFE_PARSE_METHODS = new Set(["safeParse", "safeParseAsync"]);
export const ZOD_VALIDATION_METHODS = new Set([
  ...ZOD_PARSE_METHODS,
  ...ZOD_SAFE_PARSE_METHODS,
]);
export const ZOD_TRANSFORM_METHOD = "transform";
export const ZOD_THROW_ASSERTION_MATCHERS = new Set([
  "toThrow",
  "toThrowError",
]);

function staticMemberName(node) {
  if (node?.type !== "MemberExpression" || node.computed) return null;
  return node.property.type === "Identifier" ? node.property.name : null;
}

function isExpectCall(node) {
  if (node?.type !== "CallExpression") return false;
  if (node.callee.type === "Identifier") return node.callee.name === "expect";
  return (
    node.callee.type === "MemberExpression" &&
    !node.callee.computed &&
    node.callee.object.type === "Identifier" &&
    node.callee.object.name === "expect"
  );
}

function hasThrowAssertionMatcher(expectCall) {
  let current = expectCall.parent;
  while (current) {
    if (current.type === "MemberExpression") {
      if (ZOD_THROW_ASSERTION_MATCHERS.has(staticMemberName(current))) {
        return (
          current.parent?.type === "CallExpression" &&
          current.parent.callee === current
        );
      }
      current = current.parent;
      continue;
    }
    if (
      current.type === "CallExpression" ||
      current.type === "ChainExpression"
    ) {
      current = current.parent;
      continue;
    }
    break;
  }
  return false;
}

function nearestFunctionExpression(node) {
  let current = node?.parent;
  while (current) {
    if (
      current.type === "ArrowFunctionExpression" ||
      current.type === "FunctionExpression"
    ) {
      return current;
    }
    if (current.type === "FunctionDeclaration") return null;
    current = current.parent;
  }
  return null;
}

function isDirectThrowAssertionExpression(node, fn) {
  if (fn.body === node) return true;
  return (
    node.parent?.type === "ExpressionStatement" &&
    node.parent.parent?.type === "BlockStatement" &&
    node.parent.parent.parent === fn
  );
}

export function isThrowAssertionCallbackParse(node) {
  const fn = nearestFunctionExpression(node);
  if (!fn || !isDirectThrowAssertionExpression(node, fn)) return false;
  const expectCall =
    fn.parent?.type === "CallExpression" && fn.parent.arguments.includes(fn)
      ? fn.parent
      : null;
  return Boolean(
    isExpectCall(expectCall) && hasThrowAssertionMatcher(expectCall),
  );
}

export function validationCallParts(node, methods = ZOD_VALIDATION_METHODS) {
  if (node?.type !== "CallExpression") return null;
  const callee = node.callee;
  if (callee?.type !== "MemberExpression" || callee.computed) return null;
  if (
    callee.property.type !== "Identifier" ||
    !methods.has(callee.property.name)
  ) {
    return null;
  }
  if (node.arguments.length === 0) return null;
  if (node.arguments[0].type === "SpreadElement") return null;
  return {
    callee,
    receiver: callee.object,
    argument: node.arguments[0],
    method: callee.property.name,
    safe: ZOD_SAFE_PARSE_METHODS.has(callee.property.name),
  };
}
