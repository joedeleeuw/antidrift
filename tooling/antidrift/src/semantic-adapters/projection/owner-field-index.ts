import type ts from "typescript";

import { objectType } from "../shape/contract-types.ts";
import { maxOwnerDepth } from "./owner-projection-view.ts";
import type { OwnerCandidate } from "./owner-projection-view.ts";

export type CandidateRoot = {
  candidate: OwnerCandidate;
  root: ts.Type;
};

export type OwnerFieldIndex = {
  readonly fields: ReadonlySet<string>;
  readonly directTypes: ReadonlySet<ts.Type>;
  readonly properties: readonly ts.Symbol[];
  readonly complete: boolean;
};

function indexRootFields(
  checker: ts.TypeChecker,
  root: ts.Type
): OwnerFieldIndex {
  const properties = checker.getPropertiesOfType(root);
  const propertyTypes = new Map<ts.Symbol, ts.Type>();
  function propertyType(property: ts.Symbol) {
    const cached = propertyTypes.get(property);
    if (cached) {
      return cached;
    }
    const type = checker.getNonNullableType(checker.getTypeOfSymbol(property));
    propertyTypes.set(property, type);
    return type;
  }
  const directTypes = new Set(properties.map(propertyType));
  const fields = new Set(properties.map((property) => property.name));
  const visited = new Set([root]);
  const pending = [{ type: root, depth: maxOwnerDepth }];
  let visits = 0;
  for (const current of pending) {
    if (visits >= 4096) {
      return { fields, directTypes, properties, complete: false };
    }
    visits += 1;
    if (current.depth === 0) {
      continue;
    }
    for (const property of checker.getPropertiesOfType(current.type)) {
      fields.add(property.name);
      const type = propertyType(property);
      if (objectType(type) && !visited.has(type)) {
        visited.add(type);
        pending.push({ type, depth: current.depth - 1 });
      }
    }
  }
  return { fields, directTypes, properties, complete: true };
}

export function pendingOwnerRoots(
  checker: ts.TypeChecker,
  roots: ReadonlyMap<ts.Type, CandidateRoot[]>,
  target: ts.Type,
  indexes: Map<ts.Type, OwnerFieldIndex>
) {
  const fields = new Set(
    checker.getPropertiesOfType(target).map((property) => property.name)
  );
  if (fields.size === 0) {
    return [];
  }
  return [...roots]
    .flatMap(([root, entries]) => {
      const index = indexes.get(root) ?? indexRootFields(checker, root);
      indexes.set(root, index);
      if (
        index.complete &&
        ![...fields].some((field) => index.fields.has(field))
      ) {
        return [];
      }
      return [
        {
          root,
          entries,
          targetsDirectly: index.directTypes.has(target),
          score: index.properties.filter((property) =>
            fields.has(property.name)
          ).length,
        },
      ];
    })
    .sort(
      (left, right) =>
        Number(right.targetsDirectly) - Number(left.targetsDirectly) ||
        right.score - left.score
    );
}
