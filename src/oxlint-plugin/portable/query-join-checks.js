import { findDescendant, isMemberAccess } from "./ast.js";
import { patternIdentifiers } from "./static-resolution.js";
import {
  findVariable,
  functionReturnsJsx,
  isFunctionLike,
  staticPropertyName,
  unwrapExpression,
} from "../shared/scope.js";

const OUTER_METHODS = new Set(["map", "flatMap", "filter"]);
const INNER_METHODS = new Set(["find", "filter"]);
const LOOP_TYPES = new Set([
  "ForOfStatement",
  "ForStatement",
  "WhileStatement",
]);

function isIterationCall(node, methods) {
  return (
    node?.type === "CallExpression" &&
    node.callee?.type === "MemberExpression" &&
    !node.callee.computed &&
    methods.has(node.callee.property?.name) &&
    isFunctionLike(unwrapExpression(node.arguments[0]))
  );
}

function isInside(node, ancestor) {
  for (let current = node; current; current = current.parent) {
    if (current === ancestor) return true;
    if (isFunctionLike(current)) return false;
  }
  return false;
}

function isLoopBinding(identifier, loop, sourceCode) {
  const binding = findVariable(sourceCode, identifier);
  if (!binding) return false;
  if (binding.defs.some((definition) => isInside(definition.node, loop))) {
    return true;
  }
  if (
    loop.type === "ForOfStatement" &&
    loop.left.type === "Identifier" &&
    findVariable(sourceCode, loop.left) === binding
  ) {
    return true;
  }
  return binding.references.some(
    (reference) =>
      isInside(reference.identifier, loop.test) ||
      (reference.isWrite() && isInside(reference.identifier, loop))
  );
}

function iterationOwns(identifier, call, sourceCode) {
  for (let current = call.parent; current; current = current.parent) {
    if (isFunctionLike(current)) {
      const outerCall = current.parent;
      const parameter = current.params[0];
      return (
        isIterationCall(outerCall, OUTER_METHODS) &&
        outerCall.arguments[0] === current &&
        parameter?.type === "Identifier" &&
        findVariable(sourceCode, parameter) ===
          findVariable(sourceCode, identifier)
      );
    }
    if (
      LOOP_TYPES.has(current.type) &&
      isInside(call, current.body) &&
      isLoopBinding(identifier, current, sourceCode)
    ) {
      return true;
    }
  }
  return false;
}

function propertyOwner(expression) {
  const member = unwrapExpression(expression);
  if (member?.type !== "MemberExpression" || member.computed) return null;
  const owner = unwrapExpression(member.object);
  return owner?.type === "Identifier" ? owner : null;
}

function isForeignKeyComparison(node, call, sourceCode) {
  if (node.type !== "BinaryExpression" || node.operator !== "===") return false;
  const left = propertyOwner(node.left);
  const right = propertyOwner(node.right);
  if (!left || !right) return false;
  const parameter = unwrapExpression(call.arguments[0]).params[0];
  const innerBinding = findVariable(sourceCode, parameter);
  if (!innerBinding) return false;
  const leftInner = findVariable(sourceCode, left) === innerBinding;
  const rightInner = findVariable(sourceCode, right) === innerBinding;
  return (
    leftInner !== rightInner &&
    iterationOwns(leftInner ? right : left, call, sourceCode)
  );
}

function containsForeignKeyComparison(node, call, sourceCode) {
  if (!node || isFunctionLike(node)) return false;
  if (isForeignKeyComparison(node, call, sourceCode)) return true;
  return (sourceCode.visitorKeys[node.type] ?? []).some((key) => {
    const children = Array.isArray(node[key]) ? node[key] : [node[key]];
    return children.some((child) =>
      containsForeignKeyComparison(child, call, sourceCode)
    );
  });
}

function hasIterationEquijoin(node, sourceCode) {
  if (!isIterationCall(node, INNER_METHODS)) return false;
  const callback = unwrapExpression(node.arguments[0]);
  return (
    callback.params[0]?.type === "Identifier" &&
    containsForeignKeyComparison(callback.body, node, sourceCode)
  );
}

export const HOOK_NAME = /^use[A-Z0-9]/u;
const QUERY_HOOK_NAME =
  /^use(?:Suspense)?(?:Infinite)?(?:Query|PaginatedQuery)$/u;
const QUERY_SOURCE_HOOK = /^use(?:Suspense)?(?:Query|Queries|InfiniteQuery)$/u;
const READ_CALLEE = /^(?:fetch|get|load|query|find|list|read)(?:[A-Z_\d]|$)/u;
const READ_ROOT = /^(?:api|client|ctx\.db)\./u;
const LIFECYCLE_CALLEE =
  /^(?:connect|begin|start|open|init|close|lock|acquire|login|transaction)/u;
const LIFECYCLE_ENVELOPE_KEYS = new Set([
  "isLoading",
  "isPending",
  "isError",
  "isSuccess",
  "status",
  "fetchStatus",
  "refetch",
]);
const ENVELOPE_KEYS = new Set(["data", "error", ...LIFECYCLE_ENVELOPE_KEYS]);

export function functionNameOf(node) {
  if (node.id?.type === "Identifier") return node.id.name;
  if (
    node.parent?.type === "VariableDeclarator" &&
    node.parent.id?.type === "Identifier"
  ) {
    return node.parent.id.name;
  }
  return null;
}

export function isRenderOwner(owner) {
  return (
    functionReturnsJsx(owner) || HOOK_NAME.test(functionNameOf(owner) ?? "")
  );
}

export function calleeName(call) {
  const callee = unwrapExpression(call?.callee);
  return callee?.type === "Identifier"
    ? callee.name
    : staticPropertyName(callee);
}

function queryBindings(owner, sourceCode) {
  const bindings = new Set();
  for (const statement of owner.body.body) {
    if (statement.type !== "VariableDeclaration") continue;
    for (const declarator of statement.declarations) {
      if (
        !QUERY_SOURCE_HOOK.test(calleeName(unwrapExpression(declarator.init)))
      ) {
        continue;
      }
      for (const identifier of patternIdentifiers(declarator.id)) {
        bindings.add(findVariable(sourceCode, identifier));
      }
    }
  }
  bindings.delete(null);
  return bindings;
}

function isJoinBuilder(node) {
  if (node.type === "NewExpression") return node.callee?.name === "Map";
  return (
    node.type === "CallExpression" &&
    (isMemberAccess(node.callee, "Object", "fromEntries") ||
      INNER_METHODS.has(staticPropertyName(node.callee)))
  );
}

function renderJoinSites(owner) {
  const sites = [];
  for (const statement of owner.body.body) {
    if (statement.type !== "VariableDeclaration") continue;
    for (const declarator of statement.declarations) {
      const init = unwrapExpression(declarator.init);
      const hook = calleeName(init);
      if (hook === "useMemo") sites.push(init.arguments[0]);
      else if (init && !HOOK_NAME.test(hook)) sites.push(init);
    }
  }
  return sites.filter(Boolean);
}

function joinsQueries(site, bindings) {
  const [start, end] = site.range;
  const joined = [...bindings].filter((binding) =>
    binding.references.some(
      (reference) =>
        reference.identifier.range[0] >= start &&
        reference.identifier.range[1] <= end
    )
  );
  return joined.length >= 2 && findDescendant(site, isJoinBuilder) !== null;
}

function checkRenderJoins(owner, context) {
  if (owner.body?.type !== "BlockStatement" || !isRenderOwner(owner)) return;
  const bindings = queryBindings(owner, context.sourceCode);
  if (bindings.size < 2) return;
  for (const site of renderJoinSites(owner)) {
    if (!joinsQueries(site, bindings)) continue;
    context.report({
      node: site,
      message:
        "Two or more reactive query collections are joined during render; move the join to the query select, store selector, or producer so render receives one typed projection.",
    });
  }
}

function awaitedRead(statement, sourceCode) {
  const declarator =
    statement.type === "VariableDeclaration" &&
    statement.declarations.length === 1
      ? statement.declarations[0]
      : null;
  const awaited = unwrapExpression(declarator?.init);
  const call =
    awaited?.type === "AwaitExpression"
      ? unwrapExpression(awaited.argument)
      : null;
  if (call?.type !== "CallExpression") return null;
  const name = calleeName(call);
  const isRead =
    READ_CALLEE.test(name) ||
    (READ_ROOT.test(sourceCode.getText(call.callee)) &&
      !LIFECYCLE_CALLEE.test(name));
  return isRead ? { awaited, declarator } : null;
}

function enclosingFunction(node) {
  let current = node.parent;
  while (current && !isFunctionLike(current)) current = current.parent;
  return current;
}

function checkWaterfall(block, context) {
  if (!enclosingFunction(block)?.async) return;
  let declaredNames = [];
  for (const statement of block.body) {
    const read = awaitedRead(statement, context.sourceCode);
    if (!read) {
      declaredNames = [];
      continue;
    }
    const dependent = findDescendant(
      read.awaited,
      (candidate) =>
        candidate.type === "Identifier" &&
        declaredNames.includes(candidate.name)
    );
    if (declaredNames.length > 0 && !dependent) {
      context.report({
        node: read.awaited,
        message:
          "Independent reads are awaited one after another; start them together with Promise.all([...]) so they run concurrently.",
      });
    }
    for (const identifier of patternIdentifiers(read.declarator.id)) {
      declaredNames.push(identifier.name);
    }
  }
}

export function queryJoinVisitors(context) {
  const checkFunction = (node) => checkRenderJoins(node, context);
  return {
    CallExpression(node) {
      if (!hasIterationEquijoin(node, context.sourceCode)) return;
      context.report({
        node,
        message:
          "Nested `.find()` / `.filter()` equijoin inside an iteration runs in O(N*M); pre-index the inner collection with a Map or Set before iterating.",
      });
    },
    BlockStatement: (node) => checkWaterfall(node, context),
    FunctionDeclaration: checkFunction,
    FunctionExpression: checkFunction,
    ArrowFunctionExpression: checkFunction,
  };
}

function isQueryEnvelope(node) {
  if (node?.type !== "ObjectExpression") return false;
  let hits = 0;
  let hasLifecycleKey = false;
  for (const prop of node.properties) {
    if (prop.type === "Property" && prop.key?.type === "Identifier") {
      const keyName = prop.key.name;
      if (ENVELOPE_KEYS.has(keyName)) hits += 1;
      if (LIFECYCLE_ENVELOPE_KEYS.has(keyName)) hasLifecycleKey = true;
    }
  }
  return hasLifecycleKey && hits >= 2 && hits === node.properties.length;
}

function checkReturnedExpr(returned, context, convexDirectValueHooks) {
  const node = unwrapExpression(
    returned.type === "ReturnStatement" ? returned.argument : returned
  );
  if (isQueryEnvelope(node)) {
    context.report({
      node: returned,
      message:
        "Custom hook leaks a raw query lifecycle envelope; return narrowed domain data or handle lifecycle states inside the boundary.",
    });
    return;
  }
  if (node?.type !== "Identifier") return;
  const init = findVariable(context.sourceCode, node)?.defs?.[0]?.node?.init;
  const hookName = calleeName(unwrapExpression(init));
  if (QUERY_HOOK_NAME.test(hookName) && !convexDirectValueHooks.has(hookName)) {
    context.report({
      node: returned,
      message:
        "Custom hook returns a raw query result directly; return domain data instead of forwarding the query envelope.",
    });
  }
}

export function queryEnvelopeVisitors(context) {
  const convexDirectValueHooks = new Set();
  function checkFunction(node) {
    const name = functionNameOf(node);
    if (!name || !HOOK_NAME.test(name) || QUERY_HOOK_NAME.test(name)) return;
    if (node.body?.type !== "BlockStatement") {
      checkReturnedExpr(node.body, context, convexDirectValueHooks);
      return;
    }
    for (const stmt of node.body.body) {
      if (stmt.type === "ReturnStatement" && stmt.argument) {
        checkReturnedExpr(stmt, context, convexDirectValueHooks);
      }
    }
  }
  return {
    ImportDeclaration(node) {
      if (node.source?.value !== "convex/react") return;
      for (const spec of node.specifiers ?? []) {
        if (
          spec.type === "ImportSpecifier" &&
          spec.imported?.type === "Identifier" &&
          spec.imported.name === "useQuery"
        ) {
          convexDirectValueHooks.add(spec.local.name);
        }
      }
    },
    FunctionDeclaration: checkFunction,
    FunctionExpression: checkFunction,
    ArrowFunctionExpression: checkFunction,
  };
}
