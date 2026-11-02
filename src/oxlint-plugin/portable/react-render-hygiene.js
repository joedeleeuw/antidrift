import { isRuleFile, scopeProperties } from "../shared/rule-scope.js";
import {
  findVariable,
  functionReturnsJsx,
  isFunctionLike,
  unwrapExpression,
} from "../shared/scope.js";

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
    schema: [
      {
        type: "object",
        properties: scopeProperties,
        additionalProperties: false,
      },
    ],
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
    schema: [
      {
        type: "object",
        properties: scopeProperties,
        additionalProperties: false,
      },
    ],
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

export const noQueryEnvelopeLeakRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow custom `use*` hooks that leak raw query lifecycle envelopes (`{ data, isLoading, error }`) instead of returning domain state.",
    },
    schema: [
      {
        type: "object",
        properties: scopeProperties,
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    const sourceCode = context.sourceCode;
    const convexDirectValueHooks = new Set();

    function isQueryHookCall(expr) {
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

    function checkReturnedExpr(expr, reportNode) {
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
        const v = findVariable(sourceCode, node);
        const init = v?.defs?.[0]?.node?.init;
        if (init && isQueryHookCall(init)) {
          context.report({
            node: reportNode,
            message:
              "Custom hook returns a raw query result directly; return domain data instead of forwarding the query envelope.",
          });
        }
      }
    }

    function checkFunction(node) {
      const name = functionNameOf(node);
      if (!name || !HOOK_NAME.test(name) || QUERY_HOOK_NAME.test(name)) return;
      if (node.body?.type !== "BlockStatement") {
        checkReturnedExpr(node.body, node.body);
        return;
      }
      for (const stmt of node.body.body) {
        if (stmt.type === "ReturnStatement" && stmt.argument) {
          checkReturnedExpr(stmt.argument, stmt);
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

export const noImpureRenderCallRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow impure calls (`Date.now()`, `Math.random()`, `crypto.randomUUID()`, `new Date()`) directly during React component render.",
    },
    schema: [
      {
        type: "object",
        properties: scopeProperties,
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    const sourceCode = context.sourceCode;

    function isUnshadowedGlobal(ident) {
      const variable = findVariable(sourceCode, ident);
      return !variable || variable.defs.length === 0;
    }

    function isImpureCall(node) {
      if (node.type === "NewExpression") {
        return (
          node.callee?.type === "Identifier" &&
          node.callee.name === "Date" &&
          node.arguments.length === 0 &&
          isUnshadowedGlobal(node.callee)
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
        return isUnshadowedGlobal(callee.object);
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

    function check(node) {
      if (!isImpureCall(node)) return;
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

export const noExternalDecodeInTsxRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow boundary schema decoding or JSON.parse inside .tsx component files.",
    },
    schema: [
      {
        type: "object",
        properties: scopeProperties,
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    const filename = (
      context.filename ??
      context.getFilename?.() ??
      ""
    ).replaceAll("\\", "/");
    if (!filename.endsWith(".tsx")) return {};

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

export const noQueryJoinOrTreeReshapeRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow O(N*M) nested `.find()` or `.filter()` equijoins inside outer `.map()` or `.filter()` callbacks.",
    },
    schema: [
      {
        type: "object",
        properties: scopeProperties,
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    const OUTER_METHODS = new Set(["map", "flatMap", "filter"]);
    const INNER_METHODS = new Set(["find", "filter"]);

    function isMethodCall(node, methods) {
      return (
        node?.type === "CallExpression" &&
        node.callee?.type === "MemberExpression" &&
        !node.callee.computed &&
        node.callee.property?.type === "Identifier" &&
        methods.has(node.callee.property.name) &&
        isFunctionLike(unwrapExpression(node.arguments[0]))
      );
    }

    return {
      CallExpression(node) {
        if (!isMethodCall(node, INNER_METHODS)) return;
        const innerCb = unwrapExpression(node.arguments[0]);
        const innerParam = innerCb?.params?.[0];
        if (innerParam?.type !== "Identifier") return;

        for (let cur = node.parent; cur; cur = cur.parent) {
          if (!isFunctionLike(cur)) continue;
          const outerCall =
            cur.parent?.type === "CallExpression"
              ? cur.parent
              : cur.parent?.parent;
          if (
            isMethodCall(outerCall, OUTER_METHODS) &&
            unwrapExpression(outerCall.arguments[0]) === cur
          ) {
            const outerParam = cur.params?.[0];
            if (
              outerParam?.type === "Identifier" &&
              outerParam.name !== innerParam.name
            ) {
              const text = context.sourceCode.getText(innerCb.body);
              if (
                text.includes(`${innerParam.name}.`) &&
                text.includes(`${outerParam.name}.`) &&
                text.includes("===")
              ) {
                context.report({
                  node,
                  message:
                    "Nested `.find()` / `.filter()` equijoin inside an iteration callback runs in O(N*M); pre-index the inner collection with a Map or Set before iterating.",
                });
              }
            }
            return;
          }
        }
      },
    };
  },
};
