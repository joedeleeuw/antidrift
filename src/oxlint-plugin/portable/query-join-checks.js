import { findDescendant, isMemberAccess } from "./ast.js";
import { resolveTauriIpcMethod } from "./boundary-decode-checks.js";
import { patternIdentifiers } from "./static-resolution.js";
import { checkEntityPrecedence } from "./entity-precedence.js";
import { keyedCollectionJoin } from "./keyed-collection-joins.js";
import {
  bindQueryOrigin,
  hasNewJoin,
  lifecycleKeys,
  queriesInRange,
} from "./query-provenance.js";
import { isRuleFile, scopeProperties } from "../shared/rule-scope.js";
import {
  HOOK_NAME,
  calleeName,
  constInitializer,
  findVariable,
  functionNameOf,
  isFunctionLike,
  isNullishNode,
  isRenderOwner,
  nearestFunction,
  staticPropertyKey,
  staticPropertyName,
  unwrapAwaitedExpression,
  unwrapExpression,
} from "../shared/scope.js";
import {
  isBroadResolvedType,
  resolvedPropertyShape,
} from "../shared/type-services.js";

const SCOPE_SCHEMA = [
  { type: "object", properties: scopeProperties, additionalProperties: false },
];

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

const REACTIVE_QUERY_PACKAGES =
  /^(?:@tanstack\/react-query|convex\/react|swr|@apollo\/client|@trpc\/|@reduxjs\/toolkit\/query|urql)/u;
const ADAPTER_QUERY_HOOK_NAME =
  /^use(?:Suspense)?(?:Infinite)?(?:Query|Queries|PaginatedQuery|SWR)$/u;
const QUERY_SOURCE_HOOK =
  /^use(?:[A-Z]\w*)?(?:Query|Queries|PaginatedQuery|InfiniteQuery|SWR)(?:State|Subscription)?$/u;
const READ_CALLEE =
  /^(?:fetch|get|load|query|find|list|read|select)(?:[A-Z_\d]|$)/u;
const READ_ROOT =
  /^(?:api|client|ctx\.db|db|pool|prisma|supabase|axios|ky|http)\./u;
const WRITE_OR_LIFECYCLE_CALLEE =
  /^(?:connect|begin|start|open|init|close|lock|acquire|login|transaction|create|insert|update|upsert|delete|remove|save|set|write|put|post|patch|send|emit|publish|execute|exec|run|commit|rollback|cancel|abort|reset|clear|drop|alter|migrate)/iu;
const LIFECYCLE_ENVELOPE_KEYS = lifecycleKeys;
const ENVELOPE_KEYS = new Set([
  "data",
  "results",
  "error",
  ...LIFECYCLE_ENVELOPE_KEYS,
]);
const JOIN_METHODS = new Set(["find", "filter", "map", "flatMap", "reduce"]);
const NON_JOIN_CALLEES = new Set([
  "Boolean",
  "Number",
  "String",
  "isArray",
  "is",
  "max",
  "min",
]);

function isEnvelopePropertyList(keys) {
  return (
    (keys.includes("data") || keys.includes("results")) &&
    keys.some((key) => LIFECYCLE_ENVELOPE_KEYS.has(key))
  );
}

function isImportedQueryCallee(call, sourceCode) {
  const callee = unwrapExpression(call.callee);
  let ident = null;
  if (callee?.type === "Identifier") {
    ident = callee;
  } else if (
    callee?.type === "MemberExpression" &&
    callee.object?.type === "Identifier"
  ) {
    ident = callee.object;
  }
  const def = ident ? findVariable(sourceCode, ident)?.defs?.[0] : null;
  return (
    def?.type === "ImportBinding" &&
    REACTIVE_QUERY_PACKAGES.test(def.parent?.source?.value ?? "")
  );
}

function isReactiveQueryCall(node, sourceCode) {
  const call = unwrapExpression(node);
  if (call?.type !== "CallExpression") return false;
  const name = calleeName(call);
  if (new Set(["useAtomValue", "useSelector", "useStore"]).has(name)) {
    return true;
  }
  if (!HOOK_NAME.test(name) || /(?:Mutation|Client|Context)$/u.test(name)) {
    return false;
  }
  if (QUERY_SOURCE_HOOK.test(name) || isImportedQueryCallee(call, sourceCode)) {
    return true;
  }
  const shape = resolvedPropertyShape(call, sourceCode);
  return Boolean(shape && isEnvelopePropertyList(shape.all));
}

function isIndexMapBuilder(node) {
  if (node?.type === "NewExpression") return node.callee?.name === "Map";
  return (
    node?.type === "CallExpression" &&
    isMemberAccess(node.callee, "Object", "fromEntries")
  );
}

function isMultiQueryBuilderNode(candidate, state) {
  const isBuilder =
    isIndexMapBuilder(candidate) ||
    (candidate.type === "CallExpression" &&
      JOIN_METHODS.has(staticPropertyName(candidate.callee))) ||
    (candidate.type === "ObjectExpression" &&
      candidate.properties.length >= 2 &&
      candidate.properties.some((prop) => prop.type === "SpreadElement"));
  return isBuilder && hasNewJoin(queriesInRange(candidate, state));
}

function isMultiQueryCallMerge(site, state) {
  if (
    site.type !== "CallExpression" ||
    NON_JOIN_CALLEES.has(calleeName(site)) ||
    site.arguments.length < 2
  ) {
    return false;
  }
  const argQuerySets = site.arguments
    .map((arg) => queriesInRange(arg, state).queries)
    .filter((set) => set.size > 0);
  if (argQuerySets.length < 2) return false;
  const union = new Set(argQuerySets.flatMap((set) => [...set]));
  return union.size >= 2;
}

function findDirectJoinSite(init, state) {
  const unwrapped = unwrapExpression(init);
  if (!unwrapped) return null;
  const hook = calleeName(unwrapped);
  let site = null;
  if (hook === "useMemo" || hook === "createMemo") {
    site = unwrapExpression(unwrapped.arguments[0]);
  } else if (!HOOK_NAME.test(hook)) {
    site = unwrapped;
  }
  if (!site || !hasNewJoin(queriesInRange(site, state))) return null;
  if (
    isMultiQueryCallMerge(site, state) ||
    findDescendant(site, (cand) => isMultiQueryBuilderNode(cand, state))
  ) {
    return site;
  }
  return null;
}

function isSkipSentinel(node) {
  const expr = unwrapExpression(node);
  return (
    isNullishNode(expr) || (expr?.type === "Literal" && expr.value === "skip")
  );
}

function hasGatedArgWaterfall(arg, state) {
  const expr = unwrapExpression(arg);
  if (expr?.type === "ConditionalExpression") {
    const skipConsequent = isSkipSentinel(expr.consequent);
    const skipAlternate = isSkipSentinel(expr.alternate);
    if (!skipConsequent && !skipAlternate) return false;
    const payload = skipConsequent ? expr.alternate : expr.consequent;
    const gatedOn = queriesInRange(expr.test, state, true).queries;
    const usedInPayload = queriesInRange(payload, state, true).queries;
    return [...gatedOn].some((qid) => !usedInPayload.has(qid));
  }
  if (expr?.type !== "ObjectExpression") return false;
  const enabledProp = expr.properties.find(
    (prop) => staticPropertyKey(prop) === "enabled"
  );
  if (!enabledProp) return false;
  const gatedOn = queriesInRange(enabledProp.value, state, true).queries;
  if (gatedOn.size === 0) return false;
  const usedInRest = new Set(
    expr.properties
      .filter((prop) => prop !== enabledProp)
      .flatMap((prop) => [...queriesInRange(prop, state, true).queries])
  );
  return [...gatedOn].some((qid) => !usedInRest.has(qid));
}

function isUnnecessaryQueryGate(call, state) {
  return (
    state.provenance.size > 0 &&
    call.arguments.some((arg) => hasGatedArgWaterfall(arg, state))
  );
}

function isBooleanConditionExpr(node) {
  if (!node) return false;
  if (node.type === "BinaryExpression") return true;
  if (node.type === "UnaryExpression") return node.operator === "!";
  return (
    node.type === "LogicalExpression" &&
    (node.operator === "&&" || node.operator === "||") &&
    (isBooleanConditionExpr(node.left) || isBooleanConditionExpr(node.right))
  );
}

function recordDeclaratorOrigin(init, state) {
  const { sourceCode, reportedSites, waterfallSites } = state;
  if (
    isReactiveQueryCall(init, sourceCode) ||
    (calleeName(init) === "createMemo" &&
      findDescendant(init.arguments[0], (candidate) =>
        isReactiveQueryCall(candidate, sourceCode)
      ))
  ) {
    if (isUnnecessaryQueryGate(init, state)) {
      waterfallSites.add(init);
    }
    const qid = state.nextQueryId;
    state.nextQueryId += 1;
    return { queries: new Set([qid]), mapSites: new Set() };
  }
  const hook = calleeName(init);
  if (
    (HOOK_NAME.test(hook) && hook !== "useMemo") ||
    isBooleanConditionExpr(init)
  ) {
    return null;
  }
  const joinSite = findDirectJoinSite(init, state);
  const summary = queriesInRange(init, state);
  const { queries, mapSites } = summary;
  if (queries.size === 0) return null;
  if (joinSite) {
    reportedSites.add(joinSite);
    return { queries, mapSites: new Set(), alreadyReportedJoin: true };
  }
  const nextMaps = new Set(mapSites);
  if (findDescendant(init, isIndexMapBuilder)) nextMaps.add(init);
  return {
    queries,
    mapSites: nextMaps,
    alreadyReportedJoin: queries.size > 1 && !hasNewJoin(summary),
  };
}

function collectOwnerJoinState(owner, sourceCode) {
  const state = {
    sourceCode,
    provenance: new Map(),
    reportedSites: new Set(),
    waterfallSites: new Set(),
    nextQueryId: 0,
  };
  for (const statement of owner.body.body) {
    if (statement.type !== "VariableDeclaration") continue;
    for (const declarator of statement.declarations) {
      const init = unwrapExpression(declarator.init);
      const origin = init ? recordDeclaratorOrigin(init, state) : null;
      if (!origin) continue;
      bindQueryOrigin(declarator, origin, state);
    }
  }
  return state;
}

function checkRenderJoins(owner, context, state) {
  if (owner.body?.type !== "BlockStatement" || !isRenderOwner(owner)) return;
  const { nextQueryId, reportedSites, waterfallSites } = state;
  if (nextQueryId < 2) return;
  for (const site of waterfallSites) {
    context.report({
      node: site,
      message:
        "Reactive query is gated on an earlier query's completion even though its input does not depend on that query's data; run independent queries in parallel.",
    });
  }
  findDescendant(owner.body, (node) => {
    if (keyedCollectionJoin(node, state)) reportedSites.add(node);
    if (node.type !== "JSXOpeningElement" && node.type !== "CallExpression") {
      return false;
    }
    const { queries, mapSites } = queriesInRange(node, state);
    if (queries.size >= 2 && mapSites.size > 0) {
      for (const site of mapSites) reportedSites.add(site);
    }
    return false;
  });
  for (const site of reportedSites) {
    context.report({
      node: site,
      message:
        "Two or more reactive query collections are joined during render; move the join to the query select, store selector, or producer so render receives one typed projection.",
    });
  }
}

function isReadCall(call, sourceCode) {
  if (call?.type !== "CallExpression") return false;
  const name = calleeName(call);
  if (name === "json" && call.arguments.length === 0) {
    const inner = unwrapAwaitedExpression(call.callee?.object);
    return inner?.type === "CallExpression"
      ? isReadCall(inner, sourceCode)
      : true;
  }
  if (resolveTauriIpcMethod(call, sourceCode) === "invoke") {
    const cmd = call.arguments[0]?.value;
    return typeof cmd !== "string" || !WRITE_OR_LIFECYCLE_CALLEE.test(cmd);
  }
  return (
    READ_CALLEE.test(name) ||
    (READ_ROOT.test(sourceCode.getText(call.callee)) &&
      !WRITE_OR_LIFECYCLE_CALLEE.test(name))
  );
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
  return isReadCall(call, sourceCode) ? { awaited, declarator } : null;
}

function checkWaterfall(block, context) {
  if (!nearestFunction(block)?.async) return;
  const declaredNames = new Set();
  for (const statement of block.body) {
    const read = awaitedRead(statement, context.sourceCode);
    if (!read) {
      declaredNames.clear();
      continue;
    }
    const dependent = findDescendant(
      read.awaited,
      (candidate) =>
        candidate.type === "Identifier" && declaredNames.has(candidate.name)
    );
    if (declaredNames.size > 0 && !dependent) {
      context.report({
        node: read.awaited,
        message:
          "Independent reads are awaited one after another; start them together with Promise.all([...]) so they run concurrently.",
      });
    }
    for (const identifier of patternIdentifiers(read.declarator.id)) {
      declaredNames.add(identifier.name);
    }
  }
}

function receiverMethodTarget(expr, methods, sourceCode) {
  const unwrapped = unwrapExpression(expr);
  const call =
    unwrapped?.type === "Identifier"
      ? unwrapExpression(constInitializer(sourceCode, unwrapped))
      : unwrapped;
  if (!isIterationCall(call, methods)) return null;
  const receiver = unwrapExpression(call.callee.object);
  return receiver?.type === "Identifier" ? receiver.name : null;
}

const EXISTENCE_SCAN_METHODS = new Set(["some", "find"]);
const MAP_METHODS = new Set(["map"]);

function isTwoPassArrayUpsert(node, sourceCode) {
  const testReceiver = receiverMethodTarget(
    node.test,
    EXISTENCE_SCAN_METHODS,
    sourceCode
  );
  if (!testReceiver) return false;
  const mapReceiver = receiverMethodTarget(
    node.consequent,
    MAP_METHODS,
    sourceCode
  );
  return mapReceiver === testReceiver;
}

function isThenWaterfall(node, sourceCode) {
  if (
    staticPropertyName(node.callee) !== "then" ||
    !isReadCall(unwrapExpression(node.callee?.object), sourceCode)
  ) {
    return false;
  }
  const callback = unwrapExpression(node.arguments[0]);
  if (!isFunctionLike(callback)) return false;
  let bodyExpr = null;
  if (callback.body?.type === "BlockStatement") {
    const first = callback.body.body[0];
    if (callback.body.body.length === 1 && first?.type === "ReturnStatement") {
      bodyExpr = unwrapAwaitedExpression(first.argument);
    }
  } else {
    bodyExpr = unwrapAwaitedExpression(callback.body);
  }
  if (!isReadCall(bodyExpr, sourceCode)) return false;
  const paramNames = new Set(
    callback.params.flatMap(patternIdentifiers).map((ident) => ident.name)
  );
  return (
    findDescendant(
      bodyExpr,
      (cand) => cand.type === "Identifier" && paramNames.has(cand.name)
    ) === null
  );
}

function queryJoinVisitors(context) {
  const ownerStates = new WeakMap();
  const checkFunction = (node) => {
    if (node.body?.type !== "BlockStatement") return;
    const state = collectOwnerJoinState(node, context.sourceCode);
    ownerStates.set(node, state);
    checkRenderJoins(node, context, state);
  };
  return {
    ObjectExpression(node) {
      let owner = nearestFunction(node);
      while (owner && !ownerStates.has(owner)) owner = nearestFunction(owner);
      checkEntityPrecedence(node, context, ownerStates.get(owner));
    },
    CallExpression(node) {
      if (isThenWaterfall(node, context.sourceCode)) {
        context.report({
          node,
          message:
            "Independent reads are awaited one after another; start them together with Promise.all([...]) so they run concurrently.",
        });
        return;
      }
      if (!hasIterationEquijoin(node, context.sourceCode)) return;
      context.report({
        node,
        message:
          "Nested `.find()` / `.filter()` equijoin inside an iteration runs in O(N*M); pre-index the inner collection with a Map or Set before iterating.",
      });
    },
    ConditionalExpression(node) {
      if (!isTwoPassArrayUpsert(node, context.sourceCode)) return;
      context.report({
        node,
        message:
          "Two-pass array upsert scans the collection with `.some()` / `.find()` and then re-scans with `.map()`; key the collection in a Map or update in a single pass.",
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

function isEnvelopeReturningCall(call, sourceCode, convexDirectValueHooks) {
  if (call?.type !== "CallExpression") return false;
  const hookName = calleeName(call);
  if (!HOOK_NAME.test(hookName) || convexDirectValueHooks.has(hookName)) {
    return false;
  }
  const shape = resolvedPropertyShape(call, sourceCode);
  if (shape && shape.all.length > 0 && !isBroadResolvedType(call, sourceCode)) {
    return isEnvelopePropertyList(shape.all);
  }
  return (
    ADAPTER_QUERY_HOOK_NAME.test(hookName) ||
    isImportedQueryCallee(call, sourceCode)
  );
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
  const call =
    node?.type === "Identifier"
      ? unwrapExpression(
          findVariable(context.sourceCode, node)?.defs?.[0]?.node?.init
        )
      : node;
  if (
    isEnvelopeReturningCall(call, context.sourceCode, convexDirectValueHooks)
  ) {
    context.report({
      node: returned,
      message:
        "Custom hook returns a raw query result directly; return domain data instead of forwarding the query envelope.",
    });
  }
}

function queryEnvelopeVisitors(context) {
  const convexDirectValueHooks = new Set();
  function checkFunction(node) {
    const name = functionNameOf(node);
    if (!name || !HOOK_NAME.test(name) || ADAPTER_QUERY_HOOK_NAME.test(name)) {
      return;
    }
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

export const noQueryEnvelopeLeakRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow custom `use*` hooks that leak raw query lifecycle envelopes (`{ data, isLoading, error }`) instead of returning domain state.",
    },
    schema: SCOPE_SCHEMA,
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    return queryEnvelopeVisitors(context);
  },
};

export const noQueryJoinOrTreeReshapeRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow O(N*M) `.find()` / `.filter()` equijoins inside iterations, multi-query joins during render, and sequential independent awaits.",
    },
    schema: SCOPE_SCHEMA,
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    return queryJoinVisitors(context);
  },
};
