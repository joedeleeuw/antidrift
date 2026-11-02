import { isRuleFile, scopeProperties } from "../shared/rule-scope.js";
import {
  findVariable,
  isFunctionLike,
  unwrapExpression,
} from "../shared/scope.js";

function isUseStateCall(node) {
  const unwrapped = unwrapExpression(node);
  if (unwrapped?.type !== "CallExpression") return false;
  const callee = unwrapExpression(unwrapped.callee);
  return (
    (callee?.type === "Identifier" && callee.name === "useState") ||
    (callee?.type === "MemberExpression" &&
      !callee.computed &&
      callee.object?.type === "Identifier" &&
      callee.object.name === "React" &&
      callee.property?.type === "Identifier" &&
      callee.property.name === "useState")
  );
}

function isAbortOrGenerationGuardNode(node) {
  let found = false;
  function visit(current) {
    if (found || !current || typeof current !== "object") return;
    if (
      current.type === "Identifier" &&
      /^(?:AbortController|signal|aborted|cancelled|canceled|generation|epoch|version|requestId|disposed)$/iu.test(
        current.name
      )
    ) {
      found = true;
      return;
    }
    for (const [key, value] of Object.entries(current)) {
      if (key === "parent" || key === "range" || key === "loc") continue;
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
      } else if (value && typeof value === "object") {
        visit(value);
      }
    }
  }
  visit(node);
  return found;
}

const DUAL_CHANNEL_METHODS = new Set([
  "activate",
  "bind",
  "setOnError",
  "registerError",
]);

function isReducerCrossTransitionReturn(stmt, boolProps) {
  if (
    stmt.type !== "ReturnStatement" ||
    stmt.argument?.type !== "ObjectExpression"
  ) {
    return false;
  }
  let hasTrue = false;
  let hasFalse = false;
  for (const prop of stmt.argument.properties) {
    if (
      prop.type === "Property" &&
      prop.key?.type === "Identifier" &&
      boolProps.has(prop.key.name) &&
      prop.value?.type === "Literal" &&
      typeof prop.value.value === "boolean"
    ) {
      if (prop.value.value) hasTrue = true;
      else hasFalse = true;
    }
  }
  return hasTrue && hasFalse;
}

function checkReducerMutuallyExclusiveFlags(fnNode, context) {
  const firstParam = fnNode.params?.[0];
  const typeNode = firstParam?.typeAnnotation?.typeAnnotation;
  if (typeNode?.type !== "TSTypeLiteral") return;
  const boolProps = new Set();
  for (const member of typeNode.members) {
    if (
      member.type === "TSPropertySignature" &&
      member.key?.type === "Identifier" &&
      member.typeAnnotation?.typeAnnotation?.type === "TSBooleanKeyword"
    ) {
      boolProps.add(member.key.name);
    }
  }
  if (boolProps.size < 3) return;
  let crossTransitionCount = 0;
  function visit(cur) {
    if (!cur || typeof cur !== "object") return;
    if (cur !== fnNode && isFunctionLike(cur)) return;
    if (isReducerCrossTransitionReturn(cur, boolProps)) {
      crossTransitionCount += 1;
    }
    for (const [k, v] of Object.entries(cur)) {
      if (k === "parent" || k === "range" || k === "loc") continue;
      if (Array.isArray(v)) {
        for (const item of v) visit(item);
      } else if (v && typeof v === "object") {
        visit(v);
      }
    }
  }
  visit(fnNode.body);
  if (crossTransitionCount >= 2) {
    context.report({
      node: fnNode,
      message:
        "Reducer co-mutates >= 3 boolean activity flags as mutually exclusive phases; replace with a single discriminated phase union.",
    });
  }
}

function classifyCollectionCall(cur, collectionFields) {
  if (
    cur.type !== "CallExpression" ||
    cur.callee?.type !== "MemberExpression" ||
    cur.callee.computed ||
    cur.callee.property?.type !== "Identifier"
  ) {
    return null;
  }
  const method = cur.callee.property.name;
  const obj = cur.callee.object;
  const field =
    obj?.type === "MemberExpression" &&
    obj.object?.type === "ThisExpression" &&
    obj.property?.type === "Identifier" &&
    collectionFields.has(obj.property.name)
      ? obj.property.name
      : null;
  return { method, field };
}

function recordCollectionCall(
  cur,
  callInfo,
  inAsyncContinuation,
  isGuardedMethod,
  clearedFields,
  unguardedAsyncWrites
) {
  if (!callInfo.field) return;
  if (callInfo.method === "clear" || callInfo.method === "delete") {
    clearedFields.add(callInfo.field);
    return;
  }
  if (
    (callInfo.method === "set" || callInfo.method === "add") &&
    inAsyncContinuation &&
    !isGuardedMethod
  ) {
    unguardedAsyncWrites.push({ field: callInfo.field, node: cur });
  }
}

function checkClassStaleAsyncHydration(classNode, context) {
  const collectionFields = new Set();
  for (const item of classNode.body?.body ?? []) {
    if (
      item.type === "PropertyDefinition" &&
      item.key?.type === "Identifier" &&
      item.value?.type === "NewExpression" &&
      item.value.callee?.type === "Identifier" &&
      (item.value.callee.name === "Map" || item.value.callee.name === "Set")
    ) {
      collectionFields.add(item.key.name);
    }
  }
  if (collectionFields.size === 0) return;
  const clearedFields = new Set();
  const unguardedAsyncWrites = [];

  for (const item of classNode.body?.body ?? []) {
    if (item.type !== "MethodDefinition") continue;
    const isGuardedMethod = isAbortOrGenerationGuardNode(item.value?.body);
    function scan(cur, inAsyncContinuation) {
      if (!cur || typeof cur !== "object") return;
      const callInfo = classifyCollectionCall(cur, collectionFields);
      if (callInfo) {
        recordCollectionCall(
          cur,
          callInfo,
          inAsyncContinuation,
          isGuardedMethod,
          clearedFields,
          unguardedAsyncWrites
        );
        if (callInfo.method === "then" && isFunctionLike(cur.arguments[0])) {
          scan(cur.arguments[0].body, true);
          return;
        }
      }
      for (const [k, v] of Object.entries(cur)) {
        if (k === "parent" || k === "range" || k === "loc") continue;
        if (Array.isArray(v)) {
          for (const child of v) scan(child, inAsyncContinuation);
        } else if (v && typeof v === "object") {
          scan(v, inAsyncContinuation);
        }
      }
    }
    scan(item.value?.body, false);
  }
  for (const write of unguardedAsyncWrites) {
    if (clearedFields.has(write.field)) {
      context.report({
        node: write.node,
        message: `Async hydration write to 'this.${write.field}' can overwrite a synchronous clear/delete without a generation or abort guard.`,
      });
    }
  }
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow hand-rolled resource-lifecycle state machines: an async transition that toggles a boolean lifecycle cell, resets and assigns an error cell, and assigns an awaited resource cell.",
    },
    schema: [
      {
        type: "object",
        properties: {
          ...scopeProperties,
          threshold: { type: "number" },
          shardThreshold: { type: "number" },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    const sourceCode = context.sourceCode;
    const setterVariables = new Set();
    const fnStack = [];

    function enterFunction(node) {
      checkReducerMutuallyExclusiveFlags(node, context);
      fnStack.push({
        node,
        isAsync: Boolean(node.async),
        hasAwait: false,
        hasCatch: false,
        booleanFlagsDeclared: new Set(),
        booleanSetterToggledTrue: new Set(),
        booleanSetterToggledFalse: new Set(),
        errorSetterCalledInCatch: new Set(),
        resourceSetterCalled: new Set(),
        childCrossFlagTransitions: false,
      });
    }

    function exitFunction() {
      const frame = fnStack.pop();
      if (!frame) return;
      const parentFrame = fnStack.at(-1);
      const hasCrossFlag = [...frame.booleanSetterToggledTrue].some((t) =>
        [...frame.booleanSetterToggledFalse].some((f) => f !== t)
      );
      if (
        parentFrame &&
        (hasCrossFlag || frame.booleanSetterToggledFalse.size >= 2)
      ) {
        parentFrame.childCrossFlagTransitions = true;
      }
      if (
        frame.booleanFlagsDeclared.size >= 3 &&
        frame.childCrossFlagTransitions
      ) {
        context.report({
          node: frame.node,
          message:
            "Hook defines >= 3 boolean activity flags co-mutated across transition handlers as mutually exclusive phases; model a single discriminated phase union.",
        });
      }
      if (!frame.isAsync && !frame.hasAwait) return;
      if (isAbortOrGenerationGuardNode(frame.node)) return;
      const toggledBool = [...frame.booleanSetterToggledTrue].some((v) =>
        frame.booleanSetterToggledFalse.has(v)
      );
      if (
        toggledBool &&
        frame.errorSetterCalledInCatch.size > 0 &&
        frame.resourceSetterCalled.size > 0
      ) {
        context.report({
          node: frame.node,
          message:
            "This async transition hand-rolls a resource lifecycle: a constant lifecycle cell is toggled around the request while sibling cells receive the resource value and caught error. Model one resource/reducer value instead of coupled setters.",
        });
      }
    }

    function insideCatch(node) {
      for (let current = node.parent; current; current = current.parent) {
        if (current.type === "CatchClause") return true;
        if (isFunctionLike(current)) return false;
      }
      return false;
    }

    return {
      FunctionDeclaration: enterFunction,
      "FunctionDeclaration:exit": exitFunction,
      FunctionExpression: enterFunction,
      "FunctionExpression:exit": exitFunction,
      ArrowFunctionExpression: enterFunction,
      "ArrowFunctionExpression:exit": exitFunction,
      ClassDeclaration(node) {
        checkClassStaleAsyncHydration(node, context);
      },
      ClassExpression(node) {
        checkClassStaleAsyncHydration(node, context);
      },
      VariableDeclarator(node) {
        if (
          node.id?.type === "ArrayPattern" &&
          node.id.elements.length >= 2 &&
          node.id.elements[1]?.type === "Identifier" &&
          isUseStateCall(node.init)
        ) {
          const v = findVariable(sourceCode, node.id.elements[1]);
          if (v) {
            setterVariables.add(v);
            const initArg = unwrapExpression(node.init)?.arguments?.[0];
            if (
              initArg?.type === "Literal" &&
              typeof initArg.value === "boolean"
            ) {
              fnStack.at(-1)?.booleanFlagsDeclared.add(v);
            }
          }
        }
      },
      AwaitExpression() {
        const frame = fnStack.at(-1);
        if (frame) frame.hasAwait = true;
      },
      CatchClause() {
        const frame = fnStack.at(-1);
        if (frame) frame.hasCatch = true;
      },
      CallExpression(node) {
        if (
          node.callee?.type === "MemberExpression" &&
          !node.callee.computed &&
          node.callee.property?.type === "Identifier" &&
          DUAL_CHANNEL_METHODS.has(node.callee.property.name)
        ) {
          for (const arg of node.arguments) {
            if (arg.type !== "Identifier") continue;
            const v = findVariable(sourceCode, arg);
            if (v && setterVariables.has(v)) {
              context.report({
                node: arg,
                message: `React state setter '${arg.name}' is passed into store method '${node.callee.property.name}', creating dual-channel state ownership; read the fact from the store snapshot instead.`,
              });
            }
          }
        }
        const frame = fnStack.at(-1);
        if (!frame || node.callee?.type !== "Identifier") return;
        const variable = findVariable(sourceCode, node.callee);
        if (!variable || !setterVariables.has(variable)) return;
        const arg = unwrapExpression(node.arguments[0]);
        if (arg?.type === "Literal" && typeof arg.value === "boolean") {
          if (arg.value) {
            frame.booleanSetterToggledTrue.add(variable);
          } else {
            frame.booleanSetterToggledFalse.add(variable);
          }
          return;
        }
        if (insideCatch(node)) {
          frame.errorSetterCalledInCatch.add(variable);
          return;
        }
        if (arg && !(arg.type === "Literal" && arg.value === null)) {
          frame.resourceSetterCalled.add(variable);
        }
      },
    };
  },
};
