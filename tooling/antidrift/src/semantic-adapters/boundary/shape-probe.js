import {
  countShapeProbesIn,
  hasBroadObjectEntriesBinding,
  objectEntriesCallbackProbe,
} from "./broad-input.ts";

function isTypePredicateReturn(callback) {
  return callback.returnType?.typeAnnotation?.type === "TSTypePredicate";
}

export function defensiveShapeProbe(node, services, checker) {
  const probe = objectEntriesCallbackProbe(node);
  if (!probe || isTypePredicateReturn(probe.callback)) return null;
  if (countShapeProbesIn(probe.callback.body, probe.paramNames) < 4) {
    return null;
  }
  if (
    probe.valueBindings.some(
      (binding) => !services.esTreeNodeToTSNodeMap.get(binding)
    )
  ) {
    return { status: "incomplete" };
  }
  if (!hasBroadObjectEntriesBinding(probe, services, checker)) return null;
  return { status: "report", callback: probe.callback };
}
