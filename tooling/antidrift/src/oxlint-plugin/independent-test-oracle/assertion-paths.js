import {
  equalityMatcherMethods,
  equalityMethods,
  resolutionDepthLimit,
  unwrapAwaitedExpression,
  unwrapExpression,
} from "../shared/test-block-arrangement.js";
import { staticPropertyName } from "../shared/test-files.js";

const outcomeFlagProperties = new Set(["success", "ok"]);
const outcomeFlagMethods = new Set(["isOk", "isErr", "isSuccess", "isFailure"]);

function memberSegment(member) {
  if (!member.computed && member.property.type === "Identifier") {
    return member.property.name;
  }
  if (
    member.property.type === "Literal" &&
    (typeof member.property.value === "string" ||
      typeof member.property.value === "number")
  ) {
    return member.property.value;
  }
  return null;
}

export function memberPathReference(expression) {
  const path = [];
  let current = unwrapExpression(expression);
  while (current?.type === "MemberExpression") {
    const segment = memberSegment(current);
    if (segment === null) {
      return null;
    }
    path.unshift(segment);
    current = unwrapExpression(current.object);
  }
  return current ? { root: current, path } : null;
}

export function actForRoot(root, bindings) {
  if (!root) {
    return null;
  }
  if (root.type === "CallExpression") {
    return root;
  }
  if (root.type === "Identifier") {
    const bound = unwrapAwaitedExpression(bindings.get(root.name));
    return bound?.type === "CallExpression" ? bound : null;
  }
  return null;
}

export function arrangedActForRoot(root, bindings) {
  const act = actForRoot(root, bindings);
  return act && act.arguments.length > 0 ? act : null;
}

export function arrangedActPathForExpression(
  expression,
  bindings,
  depth = resolutionDepthLimit
) {
  const target = unwrapExpression(expression);
  if (!target || depth <= 0) {
    return null;
  }
  if (target.type === "Identifier") {
    const act = arrangedActForRoot(target, bindings);
    if (act) {
      return { act, path: [] };
    }
    const binding = bindings.get(target.name);
    return binding
      ? arrangedActPathForExpression(binding, bindings, depth - 1)
      : null;
  }
  if (target.type === "MemberExpression") {
    const pathReference = memberPathReference(target);
    if (!pathReference) {
      return null;
    }
    const base = arrangedActPathForExpression(
      pathReference.root,
      bindings,
      depth - 1
    );
    return base
      ? { act: base.act, path: [...base.path, ...pathReference.path] }
      : null;
  }
  if (
    target.type === "CallExpression" &&
    target.callee.type === "MemberExpression"
  ) {
    const base = arrangedActPathForExpression(
      target.callee.object,
      bindings,
      depth - 1
    );
    if (base) {
      const method = staticPropertyName(target.callee);
      return method ? { act: base.act, path: [...base.path, method] } : null;
    }
  }
  const act = arrangedActForRoot(target, bindings);
  return act ? { act, path: [] } : null;
}

export function pathsEqual(left, right) {
  return (
    left.length === right.length &&
    left.every((segment, index) => String(segment) === String(right[index]))
  );
}

export function equalityOperands(record) {
  if (record.kind === "expect") {
    if (
      !equalityMatcherMethods.has(record.matcher) ||
      record.modifiers.has("not") ||
      record.modifiers.has("rejects")
    ) {
      return null;
    }
    return { actual: record.subject, expected: record.args[0] ?? null };
  }
  if (!equalityMethods.has(record.method)) {
    return null;
  }
  return {
    actual: record.args[0] ? unwrapExpression(record.args[0]) : null,
    expected: record.args[1] ?? null,
  };
}

export function isOutcomeFlagExpression(expression, bindings) {
  const pathReference = memberPathReference(expression);
  if (
    pathReference &&
    pathReference.path.length > 0 &&
    outcomeFlagProperties.has(String(pathReference.path.at(-1)))
  ) {
    return Boolean(arrangedActForRoot(pathReference.root, bindings));
  }
  const call = unwrapExpression(expression);
  if (
    call?.type !== "CallExpression" ||
    call.callee.type !== "MemberExpression"
  ) {
    return false;
  }
  const receiverReference = memberPathReference(call.callee.object);
  return (
    outcomeFlagMethods.has(staticPropertyName(call.callee)) &&
    call.arguments.length === 0 &&
    Boolean(
      receiverReference && arrangedActForRoot(receiverReference.root, bindings)
    )
  );
}
