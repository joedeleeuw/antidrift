import type ts from "typescript";

import { ownerProjections } from "../projection/owner-projection.ts";
import type { OwnerScope } from "./owner-scope.ts";

const projectionIndexes = new WeakMap<
  ts.TypeChecker,
  Map<string, ReturnType<typeof ownerProjections>>
>();
const candidateTypeIds = new WeakMap<ts.Type, number>();
let nextCandidateTypeId = 1;

function candidateTypeId(candidate: OwnerScope["candidates"][number]) {
  if (!candidate.type) {
    return 0;
  }
  const existing = candidateTypeIds.get(candidate.type);
  if (existing) {
    return existing;
  }
  const identifier = nextCandidateTypeId;
  nextCandidateTypeId += 1;
  candidateTypeIds.set(candidate.type, identifier);
  return identifier;
}

export function sharedOwnerProjections(
  scope: OwnerScope,
  candidates: OwnerScope["candidates"],
  packageRoot: string
) {
  const key = `${packageRoot}\0${candidates
    .map(
      (candidate) =>
        `${candidate.authority}:${candidate.authorityState}:${candidate.reverses === true}:${candidate.specifier ?? ""}:${candidateTypeId(candidate)}:${candidate.label}`
    )
    .toSorted()
    .join("\0")}`;
  const cache =
    projectionIndexes.get(scope.checker) ??
    new Map<string, ReturnType<typeof ownerProjections>>();
  projectionIndexes.set(scope.checker, cache);
  const cached = cache.get(key);
  if (cached) {
    return cached;
  }
  const projections = ownerProjections(scope.checker, candidates, packageRoot);
  if (cache.size >= 32) {
    const oldest = cache.keys().next();
    if (oldest.done !== true) {
      cache.delete(oldest.value);
    }
  }
  cache.set(key, projections);
  return projections;
}
