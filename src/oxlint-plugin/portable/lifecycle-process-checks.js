import { findDescendant } from "./ast.js";
import { ruleFilename } from "../shared/rule-scope.js";
import {
  findVariable,
  isFunctionLike,
  isTestFile,
  staticPropertyName,
  unwrapExpression,
} from "../shared/scope.js";

const EFFECT_HOOKS = new Set(["useEffect", "useLayoutEffect"]);
const HOOK_NAME = /^use[A-Z0-9]/u;
const POLLED_EVENT_STATE = new Set([
  "readyState",
  "exitCode",
  "connected",
  "closed",
]);
const NON_EVENT_TARGET_RECEIVER = /(?:^document|^win|popup|window)$/iu;
const SHADOW_STATE_MIRROR_MESSAGE =
  "This state cell copies a prop or hook result and is only re-synced from an effect, so it renders one frame stale. Derive the value during render, or key the component to reset it.";

function calleeName(call) {
  const callee = unwrapExpression(call?.callee);
  return callee?.type === "Identifier"
    ? callee.name
    : staticPropertyName(callee);
}

function nearestFunction(node) {
  let current = node?.parent;
  while (current && !isFunctionLike(current)) current = current.parent;
  return current ?? null;
}

function collectDescendants(root, predicate) {
  const matches = [];
  findDescendant(
    root,
    (candidate) => {
      if (predicate(candidate)) matches.push(candidate);
      return false;
    },
    (candidate) => candidate === root || !isFunctionLike(candidate)
  );
  return matches;
}

function booleanMemberNames(typeNode) {
  const names = new Set();
  for (const member of typeNode?.members ?? []) {
    if (
      member.type === "TSPropertySignature" &&
      member.key?.type === "Identifier" &&
      member.typeAnnotation?.typeAnnotation?.type === "TSBooleanKeyword"
    ) {
      names.add(member.key.name);
    }
  }
  return names;
}

function isCrossTransitionReturn(statement, booleanProps) {
  if (
    statement.type !== "ReturnStatement" ||
    statement.argument?.type !== "ObjectExpression"
  ) {
    return false;
  }
  const phaseValues = new Set(
    statement.argument.properties
      .filter(
        (prop) =>
          prop.type === "Property" &&
          booleanProps.has(prop.key?.name) &&
          typeof prop.value?.value === "boolean"
      )
      .map((prop) => prop.value.value)
  );
  return phaseValues.size === 2;
}

export function checkReducerMutuallyExclusiveFlags(fnNode, context) {
  const booleanProps = booleanMemberNames(
    fnNode.params?.[0]?.typeAnnotation?.typeAnnotation
  );
  if (booleanProps.size < 3) return;
  const transitions = collectDescendants(fnNode.body, (candidate) =>
    isCrossTransitionReturn(candidate, booleanProps)
  );
  if (transitions.length >= 2) {
    context.report({
      node: fnNode,
      message:
        "Reducer co-mutates >= 3 boolean activity flags as mutually exclusive phases; replace with a single discriminated phase union.",
    });
  }
}

function isMirrorSource(expression, owner, sourceCode) {
  const root =
    expression?.type === "MemberExpression"
      ? unwrapExpression(expression.object)
      : expression;
  const definition =
    root?.type === "Identifier"
      ? findVariable(sourceCode, root)?.defs?.[0]
      : null;
  if (definition?.type === "Parameter") return definition.node === owner;
  return (
    definition?.type === "Variable" &&
    HOOK_NAME.test(calleeName(unwrapExpression(definition.node.init)))
  );
}

function isEffectResync(reference, sourceText, sourceCode) {
  const call = reference.identifier.parent;
  if (call?.type !== "CallExpression" || call.callee !== reference.identifier) {
    return null;
  }
  const effect = nearestFunction(call)?.parent;
  if (
    effect?.type !== "CallExpression" ||
    !EFFECT_HOOKS.has(calleeName(effect)) ||
    nearestFunction(call) !== unwrapExpression(effect.arguments[0])
  ) {
    return null;
  }
  return call.arguments[0]
    ? sourceCode.getText(call.arguments[0]) === sourceText
    : false;
}

export function checkShadowStateMirror(declarator, owner, context) {
  const sourceCode = context.sourceCode;
  const initial = unwrapExpression(
    unwrapExpression(declarator.init).arguments?.[0]
  );
  const setter = declarator.id.elements[1];
  if (!isMirrorSource(initial, owner, sourceCode)) return;
  const sourceText = sourceCode.getText(initial);
  const resyncs = (findVariable(sourceCode, setter)?.references ?? [])
    .filter((reference) => reference.identifier !== setter)
    .map((reference) => isEffectResync(reference, sourceText, sourceCode));
  if (
    resyncs.length > 0 &&
    resyncs.every((resync) => resync !== null) &&
    resyncs.includes(true)
  ) {
    context.report({ node: declarator, message: SHADOW_STATE_MIRROR_MESSAGE });
  }
}

function intervalCallback(node) {
  if (calleeName(node) !== "setInterval") return null;
  const callee = unwrapExpression(node.callee);
  const receiver = callee?.type === "MemberExpression" ? callee.object : null;
  if (
    receiver &&
    !/^(?:globalThis|window|global|timers)$/u.test(receiver.name ?? "")
  ) {
    return null;
  }
  const callback = unwrapExpression(node.arguments[0]);
  return isFunctionLike(callback) ? callback : null;
}

function isPolledEventState(candidate, sourceCode) {
  return (
    candidate.type === "MemberExpression" &&
    POLLED_EVENT_STATE.has(staticPropertyName(candidate)) &&
    !NON_EVENT_TARGET_RECEIVER.test(sourceCode.getText(candidate.object))
  );
}

export function processLifecycleVisitors(context) {
  if (isTestFile(ruleFilename(context))) return {};
  return {
    CallExpression(node) {
      const callback = intervalCallback(node);
      if (!callback) return;
      if (
        callback.body.type === "BlockStatement" &&
        callback.body.body.length === 0
      ) {
        context.report({
          node,
          message:
            "Empty setInterval callback only holds the process open; await the owning server, child process, or stdin lifecycle instead of a wall-clock hold-open timer.",
        });
        return;
      }
      const polled = collectDescendants(callback.body, (candidate) =>
        isPolledEventState(candidate, context.sourceCode)
      )[0];
      if (polled) {
        context.report({
          node,
          message: `setInterval polls '.${staticPropertyName(polled)}' on an event target; await its lifecycle event (events.once, 'exit', 'close', 'open') instead of timer-polling state.`,
        });
      }
    },
  };
}
