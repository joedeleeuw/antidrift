import type ts from "typescript";

import { boundedType, objectType } from "../shape/contract-types.ts";
import type { LocalContractScope } from "./contract-sites.ts";
import { maxOwnerDepth } from "./owner-projection-view.ts";

type RelevantVisit = {
  readonly type: ts.Type;
  readonly depth: number;
};

type ContractFields = LocalContractScope["declarations"];
type RelevantResult = {
  readonly depth: number;
  readonly declarations: ReadonlySet<ts.Node>;
};

export function contractFieldTypes(
  checker: ts.TypeChecker,
  node: ts.Node
): ReadonlyMap<string, ts.Type> {
  const type = checker.getTypeAtLocation(node);
  return new Map(
    checker
      .getPropertiesOfType(type)
      .map((property): [string, ts.Type] => [
        property.name,
        checker.getTypeOfSymbol(property),
      ])
  );
}

function typesMayMatch(
  checker: ts.TypeChecker,
  local: ts.Type,
  actual: ts.Type
): boolean {
  const localType = checker.getNonNullableType(local);
  const actualType = checker.getNonNullableType(actual);
  if (!boundedType(checker, localType) || !boundedType(checker, actualType)) {
    return true;
  }
  return (
    checker.isTypeAssignableTo(localType, actualType) ||
    checker.isTypeAssignableTo(actualType, localType)
  );
}

function matchingDeclarations(
  checker: ts.TypeChecker,
  type: ts.Type,
  contracts: ContractFields,
  fields: ReadonlyMap<string, ReadonlySet<ts.Node>>
) {
  if (!objectType(type) || type.isUnionOrIntersection()) {
    return undefined;
  }
  const declarations = new Set<ts.Node>();
  for (const property of checker.getPropertiesOfType(type)) {
    const actualType = checker.getTypeOfSymbol(property);
    for (const declaration of fields.get(property.name) ?? []) {
      const localType = contracts.get(declaration)?.get(property.name);
      if (localType && typesMayMatch(checker, localType, actualType)) {
        declarations.add(declaration);
      }
    }
  }
  return declarations.size > 0 ? declarations : undefined;
}

function expandRelevantType(
  checker: ts.TypeChecker,
  current: RelevantVisit,
  pending: RelevantVisit[],
  work: number
): number | null {
  if (current.depth === 0) {
    return work;
  }
  if (current.type.isUnionOrIntersection()) {
    for (const part of current.type.types) {
      if (work >= 4096) {
        return null;
      }
      pending.push({ type: part, depth: current.depth });
      work += 1;
    }
    return work;
  }
  if (!objectType(current.type)) {
    return work;
  }
  for (const property of checker.getPropertiesOfType(current.type)) {
    if (work >= 4096) {
      return null;
    }
    pending.push({
      type: checker.getTypeOfSymbol(property),
      depth: current.depth - 1,
    });
    work += 1;
  }
  return work;
}

export function createRelevantTypeIndex(
  checker: ts.TypeChecker,
  contracts: ContractFields
) {
  const declarations = new Set(contracts.keys());
  const fields = new Map<string, Set<ts.Node>>();
  for (const [declaration, properties] of contracts) {
    for (const name of properties.keys()) {
      const owners = fields.get(name) ?? new Set<ts.Node>();
      owners.add(declaration);
      fields.set(name, owners);
    }
  }
  const partialSearches = new Map<ts.Type, RelevantResult>();
  const completeSearches = new Map<ts.Type, RelevantResult>();

  function forType(
    type: ts.Type | undefined,
    depth = maxOwnerDepth,
    all = false
  ) {
    if (!type || declarations.size === 0) {
      return new Set<ts.Node>();
    }
    const searches = all ? completeSearches : partialSearches;
    const cached = searches.get(type);
    if (cached && cached.depth === depth) {
      return cached.declarations;
    }
    const pending: RelevantVisit[] = [{ type, depth }];
    const visited = new Map<ts.Type, number>();
    let matching: Set<ts.Node> | undefined;
    let work = 0;
    for (let index = 0; index < pending.length; index += 1) {
      const current = pending[index];
      if (!current) {
        break;
      }
      const previousDepth = visited.get(current.type);
      if (previousDepth !== undefined && previousDepth >= current.depth) {
        continue;
      }
      visited.set(current.type, current.depth);
      work += 1;
      const found =
        work <= 4096
          ? matchingDeclarations(checker, current.type, contracts, fields)
          : declarations;
      if (found) {
        const combined = new Set([...(matching ?? []), ...found]);
        if (!all || combined.size === declarations.size) {
          searches.set(type, { depth, declarations: combined });
          return combined;
        }
        matching = combined;
      }
      const expandedWork = expandRelevantType(checker, current, pending, work);
      if (expandedWork === null) {
        searches.set(type, { depth, declarations });
        return declarations;
      }
      work = expandedWork;
    }
    const absent = matching ?? new Set<ts.Node>();
    searches.set(type, { depth, declarations: absent });
    return absent;
  }

  return { forType };
}
