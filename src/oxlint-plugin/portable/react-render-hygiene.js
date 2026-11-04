import {
  hasPlatformSibling,
  isRuleFile,
  ruleFilename,
  scopeProperties,
} from "../shared/rule-scope.js";
import { findDescendant } from "./ast.js";
import { rootIdentifier } from "./static-resolution.js";
import {
  HOOK_NAME,
  calleeName,
  findVariable,
  functionNameOf,
  functionReturnsJsx,
  isFunctionLike,
  isRenderOwner,
  nearestFunction,
  staticPropertyName,
  unwrapExpression,
} from "../shared/scope.js";

const SCOPE_SCHEMA = [
  { type: "object", properties: scopeProperties, additionalProperties: false },
];

const HOOK_CALL_NAME = /^(?:use|use[A-Z0-9])/u;
const RENDER_CALLBACK_HOOKS = new Set([
  "useMemo",
  "useEffect",
  "useLayoutEffect",
  "useCallback",
]);
const DEPENDENCY_HOOKS = new Set([
  ...RENDER_CALLBACK_HOOKS,
  "useInsertionEffect",
]);
const EVENT_HANDLER_NAME = /^(?:on|handle)[A-Z]/u;
const IMPURE_MEMBER_CALLS = new Set([
  "Date.now",
  "Math.random",
  "crypto.randomUUID",
  "performance.now",
]);
const ALWAYS_DECODE_METHOD =
  /^(?:parseAsync|decodeUnknownSync|decodeUnknownEither)$/u;
const RAW_PAYLOAD_NAME = /^(?:raw|payload|response|res|body|json|data)$/iu;

function isHookCall(node) {
  return HOOK_CALL_NAME.test(calleeName(node));
}

function isPlatformHookStub(node) {
  if (node.body?.type !== "BlockStatement") return false;
  const stmts = node.body.body;
  if (stmts.length === 0) return true;
  if (stmts.length !== 1 || stmts[0].type !== "ReturnStatement") return false;
  const arg = stmts[0].argument;
  return (
    !arg ||
    arg.type === "Literal" ||
    (arg.type === "Identifier" && arg.name === "undefined")
  );
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
    let platformSibling = null;
    function enter(node) {
      stack.push({ node, name: functionNameOf(node), calledHook: false });
    }
    function exit() {
      const frame = stack.pop();
      const hookless =
        HOOK_NAME.test(frame?.name ?? "") &&
        !frame.calledHook &&
        !isPlatformHookStub(frame.node);
      if (!hookless) return;
      platformSibling ??= hasPlatformSibling(ruleFilename(context));
      if (platformSibling) return;
      context.report({
        node: frame.node.id ?? frame.node,
        message: `Function '${frame.name}' uses the 'use*' hook prefix without calling any React hook; rename it to a plain function.`,
      });
    }
    return {
      FunctionDeclaration: enter,
      "FunctionDeclaration:exit": exit,
      FunctionExpression: enter,
      "FunctionExpression:exit": exit,
      ArrowFunctionExpression: enter,
      "ArrowFunctionExpression:exit": exit,
      CallExpression(node) {
        const top = stack.at(-1);
        if (top && isHookCall(node)) top.calledHook = true;
      },
    };
  },
};

function isUnstableDefault(expr) {
  const node = unwrapExpression(expr);
  if (node?.type === "ArrayExpression") return node.elements.length === 0;
  if (node?.type === "ObjectExpression") return node.properties.length === 0;
  return (
    node?.type === "NewExpression" &&
    node.callee?.type === "Identifier" &&
    (node.callee.name === "Map" || node.callee.name === "Set")
  );
}

function isRenderStableSink(reference) {
  const parent = reference.identifier.parent;
  if (parent?.type === "JSXExpressionContainer") {
    return parent.parent?.type === "JSXAttribute";
  }
  const call = parent?.type === "ArrayExpression" ? parent.parent : null;
  return (
    call?.type === "CallExpression" &&
    call.arguments.length >= 2 &&
    call.arguments.at(-1) === parent &&
    DEPENDENCY_HOOKS.has(calleeName(call))
  );
}

function reportFallbackCollections(node, context) {
  for (const statement of node.body.body) {
    if (statement.type !== "VariableDeclaration") continue;
    for (const declarator of statement.declarations) {
      const init = unwrapExpression(declarator.init);
      const fallback =
        init?.type === "LogicalExpression" &&
        (init.operator === "??" || init.operator === "||") &&
        isUnstableDefault(init.right);
      const references = fallback
        ? (findVariable(context.sourceCode, declarator.id)?.references ?? [])
        : [];
      if (!references.some(isRenderStableSink)) continue;
      context.report({
        node: init.right,
        message:
          "Unstable collection fallback creates a fresh reference every render and reaches a prop or hook dependency; hoist a module-level empty constant.",
      });
    }
  }
}

function reportDefaultCollections(node, context) {
  for (const parameter of node.params) {
    if (parameter.type !== "ObjectPattern") continue;
    for (const prop of parameter.properties) {
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

export const noUnstableRenderDefaultCollectionRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow unstable default collection literals (`= []`, `= {}`, `= new Map()`, `= new Set()`) in React component props and `?? []` fallbacks that reach props or hook dependencies.",
    },
    schema: SCOPE_SCHEMA,
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    function checkComponent(node) {
      if (functionReturnsJsx(node)) reportDefaultCollections(node, context);
      if (node.body?.type === "BlockStatement" && isRenderOwner(node)) {
        reportFallbackCollections(node, context);
      }
    }
    return {
      FunctionDeclaration: checkComponent,
      FunctionExpression: checkComponent,
      ArrowFunctionExpression: checkComponent,
    };
  },
};

function isUnshadowedGlobal(ident, sourceCode) {
  const binding = findVariable(sourceCode, ident);
  return !binding || binding.defs.length === 0;
}

function isImpureCall(node, sourceCode) {
  const callee = node.callee;
  if (node.type === "NewExpression") {
    return (
      callee?.type === "Identifier" &&
      callee.name === "Date" &&
      node.arguments.length === 0 &&
      isUnshadowedGlobal(callee, sourceCode)
    );
  }
  return (
    node.type === "CallExpression" &&
    callee?.type === "MemberExpression" &&
    callee.object?.type === "Identifier" &&
    IMPURE_MEMBER_CALLS.has(
      `${callee.object.name}.${staticPropertyName(callee)}`
    ) &&
    isUnshadowedGlobal(callee.object, sourceCode)
  );
}

function isInParams(node, owner) {
  return owner.params.some(
    (parameter) =>
      parameter.range[0] <= node.range[0] && node.range[1] <= parameter.range[1]
  );
}

function impureHelperName(node, sourceCode) {
  if (node.type !== "CallExpression" || node.callee?.type !== "Identifier") {
    return null;
  }
  const definition = findVariable(sourceCode, node.callee)?.defs?.[0]?.node;
  const helper = isFunctionLike(definition)
    ? definition
    : unwrapExpression(definition?.init);
  if (!isFunctionLike(helper) || isRenderOwner(helper)) return null;
  const impure = findDescendant(
    helper.body,
    (candidate) => isImpureCall(candidate, sourceCode),
    (candidate) => !isFunctionLike(candidate)
  );
  return impure ? node.callee.name : null;
}

export const noImpureRenderCallRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow impure calls (`Date.now()`, `Math.random()`, `crypto.randomUUID()`, `new Date()`) during React render, in component/hook default parameters, and through 1-hop local helpers called during render.",
    },
    schema: SCOPE_SCHEMA,
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    const sourceCode = context.sourceCode;
    function check(node) {
      const owner = nearestFunction(node);
      const renderTime =
        Boolean(owner) &&
        (functionReturnsJsx(owner) ||
          (isRenderOwner(owner) && isInParams(node, owner)));
      if (!renderTime) return;
      if (isImpureCall(node, sourceCode)) {
        context.report({
          node,
          message:
            "Impure time or random call during React render breaks purity; compute in an effect, event handler, or loader.",
        });
        return;
      }
      const helper = impureHelperName(node, sourceCode);
      if (helper) {
        context.report({
          node,
          message: `Render calls helper '${helper}', which reads an impure time or random source; compute in an effect, event handler, or loader.`,
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
  const method =
    callee?.type === "MemberExpression" && !callee.computed
      ? staticPropertyName(callee)
      : "";
  const receiver =
    callee?.object?.type === "Identifier" ? callee.object.name : "";
  if (
    (receiver === "JSON" && method === "parse") ||
    ALWAYS_DECODE_METHOD.test(method)
  ) {
    return true;
  }
  if (method !== "parse" || /^(?:Date|URL|path)$/u.test(receiver)) return false;
  const arg = unwrapExpression(node.arguments[0]);
  return (
    arg?.type === "MemberExpression" ||
    arg?.type === "CallExpression" ||
    (arg?.type === "Identifier" && RAW_PAYLOAD_NAME.test(arg.name))
  );
}

function isLocalFormState(node, sourceCode) {
  const root = rootIdentifier(node.arguments[0]);
  const declarator = root
    ? findVariable(sourceCode, root)?.defs?.[0]?.node
    : null;
  return calleeName(unwrapExpression(declarator?.init)) === "useState";
}

function decodesDuringRender(node) {
  const callback = nearestFunction(node);
  if (!callback || isRenderOwner(callback)) return Boolean(callback);
  const call = callback.parent;
  if (
    call?.type !== "CallExpression" ||
    call.arguments[0] !== callback ||
    !RENDER_CALLBACK_HOOKS.has(calleeName(call))
  ) {
    return false;
  }
  const declarator = call.parent;
  const handlerName =
    declarator?.type === "VariableDeclarator" ? declarator.id?.name : "";
  const owner = nearestFunction(call);
  return (
    !EVENT_HANDLER_NAME.test(handlerName ?? "") &&
    Boolean(owner) &&
    isRenderOwner(owner)
  );
}

export const noExternalDecodeInTsxRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow boundary schema decoding or JSON.parse inside .tsx component render bodies, hooks, and render-time memo/effect callbacks.",
    },
    schema: SCOPE_SCHEMA,
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    if (!ruleFilename(context).endsWith(".tsx")) return {};
    return {
      CallExpression(node) {
        if (
          !isExternalPayloadDecodeCall(node) ||
          !decodesDuringRender(node) ||
          isLocalFormState(node, context.sourceCode)
        ) {
          return;
        }
        context.report({
          node,
          message:
            "Do not decode untrusted external payloads inside TSX components; decode once at the data boundary before rendering.",
        });
      },
    };
  },
};
