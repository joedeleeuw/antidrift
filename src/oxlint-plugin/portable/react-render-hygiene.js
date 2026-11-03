import { isRuleFile, scopeProperties } from "../shared/rule-scope.js";
import {
  findVariable,
  functionReturnsJsx,
  isFunctionLike,
  unwrapExpression,
} from "../shared/scope.js";

const SCOPE_SCHEMA = [
  { type: "object", properties: scopeProperties, additionalProperties: false },
];

const HOOK_NAME = /^use[A-Z0-9]/u;
const HOOK_CALL_NAME = /^(?:use|use[A-Z0-9])/u;
const QUERY_HOOK_NAME =
  /^use(?:Suspense)?(?:Infinite)?(?:Query|PaginatedQuery)$/u;
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

function functionNameOf(node) {
  if (node.id?.type === "Identifier") return node.id.name;
  if (
    node.parent?.type === "VariableDeclarator" &&
    node.parent.id?.type === "Identifier"
  ) {
    return node.parent.id.name;
  }
  return null;
}

function isHookCall(node) {
  const callee = unwrapExpression(node?.callee);
  if (callee?.type === "Identifier") return HOOK_CALL_NAME.test(callee.name);
  if (
    callee?.type === "MemberExpression" &&
    !callee.computed &&
    callee.property?.type === "Identifier"
  ) {
    return HOOK_CALL_NAME.test(callee.property.name);
  }
  return false;
}

export const noHooklessUseFunctionRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow functions named `use*` that never call another React hook.",
    },
    schema: SCOPE_SCHEMA,
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    const stack = [];
    function enter(node) {
      stack.push({ node, name: functionNameOf(node), calledHook: false });
    }
    function isPlatformHookStub(node) {
      if (node.body?.type !== "BlockStatement") return false;
      const stmts = node.body.body;
      if (stmts.length === 0) return true;
      if (stmts.length !== 1 || stmts[0].type !== "ReturnStatement") {
        return false;
      }
      const arg = stmts[0].argument;
      return (
        !arg ||
        arg.type === "Literal" ||
        (arg.type === "Identifier" && arg.name === "undefined")
      );
    }
    function exit() {
      const frame = stack.pop();
      if (!frame?.name || !HOOK_NAME.test(frame.name)) return;
      if (isPlatformHookStub(frame.node)) return;
      if (!frame.calledHook) {
        context.report({
          node: frame.node.id ?? frame.node,
          message: `Function '${frame.name}' uses the 'use*' hook prefix without calling any React hook; rename it to a plain function.`,
        });
      }
    }
    return {
      FunctionDeclaration: enter,
      "FunctionDeclaration:exit": exit,
      FunctionExpression: enter,
      "FunctionExpression:exit": exit,
      ArrowFunctionExpression: enter,
      "ArrowFunctionExpression:exit": exit,
      CallExpression(node) {
        if (isHookCall(node)) {
          const top = stack.at(-1);
          if (top) top.calledHook = true;
        }
      },
    };
  },
};

export const noUnstableRenderDefaultCollectionRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow unstable default collection literals (`= []`, `= {}`, `= new Map()`, `= new Set()`) in React component parameter destructuring.",
    },
    schema: SCOPE_SCHEMA,
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    function isUnstableDefault(expr) {
      const node = unwrapExpression(expr);
      if (!node) return false;
      if (node.type === "ArrayExpression" && node.elements.length === 0) {
        return true;
      }
      if (node.type === "ObjectExpression" && node.properties.length === 0) {
        return true;
      }
      return (
        node.type === "NewExpression" &&
        node.callee?.type === "Identifier" &&
        (node.callee.name === "Map" || node.callee.name === "Set")
      );
    }
    function checkComponent(node) {
      if (!functionReturnsJsx(node)) return;
      for (const param of node.params) {
        if (param.type !== "ObjectPattern") continue;
        for (const prop of param.properties) {
          if (
            prop.type === "Property" &&
            prop.value?.type === "AssignmentPattern" &&
            isUnstableDefault(prop.value.right)
          ) {
            context.report({
              node: prop.value.right,
              message:
                "Unstable collection default in component props creates a fresh reference every render; hoist a module-level constant or derive inside the body.",
            });
          }
        }
      }
    }
    return {
      FunctionDeclaration: checkComponent,
      FunctionExpression: checkComponent,
      ArrowFunctionExpression: checkComponent,
    };
  },
};

function isQueryHookCall(expr, convexDirectValueHooks) {
  const node = unwrapExpression(expr);
  if (node?.type !== "CallExpression") return false;
  const callee = unwrapExpression(node.callee);
  if (
    callee?.type !== "Identifier" ||
    !QUERY_HOOK_NAME.test(callee.name) ||
    convexDirectValueHooks.has(callee.name)
  ) {
    return false;
  }
  return true;
}

function isEnvelopeObject(expr) {
  const node = unwrapExpression(expr);
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

function checkReturnedExpr(expr, reportNode, context, convexDirectValueHooks) {
  const node = unwrapExpression(expr);
  if (!node) return;
  if (isEnvelopeObject(node)) {
    context.report({
      node: reportNode,
      message:
        "Custom hook leaks a raw query lifecycle envelope; return narrowed domain data or handle lifecycle states inside the boundary.",
    });
    return;
  }
  if (node.type === "Identifier") {
    const v = findVariable(context.sourceCode, node);
    const init = v?.defs?.[0]?.node?.init;
    if (init && isQueryHookCall(init, convexDirectValueHooks)) {
      context.report({
        node: reportNode,
        message:
          "Custom hook returns a raw query result directly; return domain data instead of forwarding the query envelope.",
      });
    }
  }
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

    const convexDirectValueHooks = new Set();

    function checkFunction(node) {
      const name = functionNameOf(node);
      if (!name || !HOOK_NAME.test(name) || QUERY_HOOK_NAME.test(name)) return;
      if (node.body?.type !== "BlockStatement") {
        checkReturnedExpr(
          node.body,
          node.body,
          context,
          convexDirectValueHooks
        );
        return;
      }
      for (const stmt of node.body.body) {
        if (stmt.type === "ReturnStatement" && stmt.argument) {
          checkReturnedExpr(
            stmt.argument,
            stmt,
            context,
            convexDirectValueHooks
          );
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
  },
};

function isUnshadowedGlobal(ident, sourceCode) {
  const variable = findVariable(sourceCode, ident);
  return !variable || variable.defs.length === 0;
}

function isImpureCall(node, sourceCode) {
  if (node.type === "NewExpression") {
    return (
      node.callee?.type === "Identifier" &&
      node.callee.name === "Date" &&
      node.arguments.length === 0 &&
      isUnshadowedGlobal(node.callee, sourceCode)
    );
  }
  if (node.type !== "CallExpression") return false;
  const callee = node.callee;
  if (
    callee?.type === "MemberExpression" &&
    !callee.computed &&
    callee.object?.type === "Identifier" &&
    callee.property?.type === "Identifier"
  ) {
    const pair = `${callee.object.name}.${callee.property.name}`;
    if (
      pair !== "Date.now" &&
      pair !== "Math.random" &&
      pair !== "crypto.randomUUID" &&
      pair !== "performance.now"
    ) {
      return false;
    }
    return isUnshadowedGlobal(callee.object, sourceCode);
  }
  return false;
}

function enclosingComponentIfInRender(node) {
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (isFunctionLike(cur)) {
      return functionReturnsJsx(cur) ? cur : null;
    }
  }
  return null;
}

export const noImpureRenderCallRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow impure calls (`Date.now()`, `Math.random()`, `crypto.randomUUID()`, `new Date()`) directly during React component render.",
    },
    schema: SCOPE_SCHEMA,
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    const sourceCode = context.sourceCode;

    function check(node) {
      if (!isImpureCall(node, sourceCode)) return;
      if (enclosingComponentIfInRender(node)) {
        context.report({
          node,
          message:
            "Impure time or random call during React render breaks purity; compute in an effect, event handler, or loader.",
        });
      }
    }

    return {
      CallExpression: check,
      NewExpression: check,
    };
  },
};

function isExternalPayloadDecodeCall(node) {
  const callee = unwrapExpression(node.callee);
  if (
    callee?.type !== "MemberExpression" ||
    callee.computed ||
    callee.property?.type !== "Identifier"
  ) {
    return false;
  }
  const method = callee.property.name;
  if (
    callee.object?.type === "Identifier" &&
    callee.object.name === "JSON" &&
    method === "parse"
  ) {
    return true;
  }
  if (
    method === "parseAsync" ||
    method === "decodeUnknownSync" ||
    method === "decodeUnknownEither"
  ) {
    return true;
  }
  if (method === "parse") {
    if (
      callee.object?.type === "Identifier" &&
      /^(?:Date|URL|path)$/u.test(callee.object.name)
    ) {
      return false;
    }
    const arg = unwrapExpression(node.arguments[0]);
    return (
      arg?.type === "MemberExpression" ||
      arg?.type === "CallExpression" ||
      (arg?.type === "Identifier" &&
        /^(?:raw|payload|response|res|body|json|data)$/iu.test(arg.name))
    );
  }
  return false;
}

function isDirectComponentRender(node) {
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (isFunctionLike(cur)) {
      return functionReturnsJsx(cur);
    }
  }
  return false;
}

export const noExternalDecodeInTsxRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow boundary schema decoding or JSON.parse inside .tsx component files.",
    },
    schema: SCOPE_SCHEMA,
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    const filename = (
      context.filename ??
      context.getFilename?.() ??
      ""
    ).replaceAll("\\", "/");
    if (!filename.endsWith(".tsx")) return {};

    return {
      CallExpression(node) {
        if (!isExternalPayloadDecodeCall(node)) return;
        if (isDirectComponentRender(node)) {
          context.report({
            node,
            message:
              "Do not decode untrusted external payloads inside TSX components; decode once at the data boundary before rendering.",
          });
        }
      },
    };
  },
};

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

function isForeignKeyComparison(node, parameter, call, sourceCode) {
  if (node.type !== "BinaryExpression" || node.operator !== "===") return false;
  const left = propertyOwner(node.left);
  const right = propertyOwner(node.right);
  if (!left || !right) return false;
  const innerBinding = findVariable(sourceCode, parameter);
  if (!innerBinding) return false;
  const leftInner = findVariable(sourceCode, left) === innerBinding;
  const rightInner = findVariable(sourceCode, right) === innerBinding;
  return (
    leftInner !== rightInner &&
    iterationOwns(leftInner ? right : left, call, sourceCode)
  );
}

function containsForeignKeyComparison(node, parameter, call, sourceCode) {
  if (!node || isFunctionLike(node)) return false;
  if (isForeignKeyComparison(node, parameter, call, sourceCode)) return true;
  return (sourceCode.visitorKeys[node.type] ?? []).some((key) => {
    const children = Array.isArray(node[key]) ? node[key] : [node[key]];
    return children.some((child) =>
      containsForeignKeyComparison(child, parameter, call, sourceCode)
    );
  });
}

export const noQueryJoinOrTreeReshapeRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow O(N*M) `.find()` or `.filter()` equijoins inside iteration callbacks or loop bodies.",
    },
    schema: SCOPE_SCHEMA,
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    return {
      CallExpression(node) {
        if (!isIterationCall(node, INNER_METHODS)) return;
        const callback = unwrapExpression(node.arguments[0]);
        const parameter = callback.params[0];
        if (
          parameter?.type !== "Identifier" ||
          !containsForeignKeyComparison(
            callback.body,
            parameter,
            node,
            context.sourceCode
          )
        ) {
          return;
        }
        context.report({
          node,
          message:
            "Nested `.find()` / `.filter()` equijoin inside an iteration runs in O(N*M); pre-index the inner collection with a Map or Set before iterating.",
        });
      },
    };
  },
};
