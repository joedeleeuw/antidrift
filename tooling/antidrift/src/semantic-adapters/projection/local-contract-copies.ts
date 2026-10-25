import ts from "typescript";

import { resolveAliasedSymbol } from "../provenance/symbol-provenance.ts";
import {
  boundedType,
  objectType,
  sameModifiers,
} from "../shape/contract-types.ts";
import { equivalentType } from "../shape/equivalent-types.ts";
import { isProjectSource } from "./contract-sites.ts";
import type { ContractProvenanceSearch } from "./contract-provenance-state.ts";
import type { OwnerProjection } from "./owner-projection-view.ts";
import { derivedComposition, nonNullable } from "./owner-projection.ts";
import { projectionProof } from "./owner-projection-proof.ts";
import type { ProjectionProof } from "./owner-projection-proof.ts";

type LocalCopy = {
  readonly local: ts.Type | undefined;
  readonly owner: OwnerProjection;
  readonly site: ts.Node;
  readonly onlyField: string | null;
  readonly depth: number;
};

function handwritten(typeNode: ts.TypeNode): boolean {
  if (ts.isParenthesizedTypeNode(typeNode)) {
    return handwritten(typeNode.type);
  }
  if (ts.isTypeLiteralNode(typeNode)) {
    return true;
  }
  if (ts.isUnionTypeNode(typeNode)) {
    return typeNode.types.every(
      (part) => ts.isLiteralTypeNode(part) || handwritten(part)
    );
  }
  return false;
}

function handwrittenNode(
  checker: ts.TypeChecker,
  node: ts.TypeNode,
  seen: ReadonlySet<ts.Symbol> = new Set()
): ts.TypeNode | null {
  if (handwritten(node)) {
    return node;
  }
  if (!ts.isTypeReferenceNode(node)) {
    return null;
  }
  const symbol = resolveAliasedSymbol(
    checker,
    checker.getSymbolAtLocation(node.typeName)
  );
  if (!symbol || seen.has(symbol)) {
    return null;
  }
  const next = new Set([...seen, symbol]);
  for (const declaration of symbol.declarations ?? []) {
    const aliased = ts.isTypeAliasDeclaration(declaration)
      ? handwrittenNode(checker, declaration.type, next)
      : null;
    if (aliased) {
      return aliased;
    }
  }
  return null;
}

function ownerFreeTypeNode(
  checker: ts.TypeChecker,
  declaration: ts.Declaration,
  owner: OwnerProjection
) {
  if (
    !ts.isPropertySignature(declaration) ||
    !declaration.type ||
    derivedComposition(checker, declaration.type, owner)
  ) {
    return null;
  }
  const node = handwrittenNode(checker, declaration.type);
  return node && !derivedComposition(checker, node, owner) ? node : null;
}

function localPropertyNode(
  checker: ts.TypeChecker,
  property: ts.Symbol,
  owner: OwnerProjection
) {
  for (const declaration of property.declarations ?? []) {
    const node = ownerFreeTypeNode(checker, declaration, owner);
    if (node) {
      return node;
    }
  }
  return null;
}

function directTypeNode(type: ts.Type) {
  for (const node of type.getSymbol()?.declarations ?? []) {
    if (
      ts.isTypeLiteralNode(node) ||
      (ts.isInterfaceDeclaration(node) && !node.heritageClauses?.length)
    ) {
      return node;
    }
  }
  return null;
}

function sameProperty(
  search: ContractProvenanceSearch,
  local: ts.Symbol,
  owner: ts.Symbol | undefined
): boolean {
  if (!owner) {
    return false;
  }
  const previous = search.comparisons.get(local)?.get(owner);
  if (previous !== undefined) {
    return previous;
  }
  const { checker } = search;
  const localType = checker.getTypeOfSymbol(local);
  const ownerType = checker.getTypeOfSymbol(owner);
  const equivalent =
    sameModifiers(local, owner) &&
    boundedType(checker, localType) &&
    boundedType(checker, ownerType) &&
    equivalentType(checker, localType, ownerType);
  search.comparisons.set(
    local,
    new Map([...(search.comparisons.get(local) ?? []), [owner, equivalent]])
  );
  return equivalent;
}

function recordProof(
  search: ContractProvenanceSearch,
  node: ts.Node,
  proof: ProjectionProof
) {
  const proofs = search.findings.get(node) ?? [];
  proofs.push(proof);
  search.findings.set(node, proofs);
}

function recordWholeCopy(
  search: ContractProvenanceSearch,
  copy: LocalCopy,
  local: ts.Type,
  fields: readonly ts.Symbol[],
  matching: readonly ts.Symbol[]
): boolean {
  const { checker } = search;
  const literal = directTypeNode(local);
  if (
    !literal ||
    matching.length !== fields.length ||
    fields.length !== checker.getPropertiesOfType(copy.owner.type).length ||
    fields.length === 0 ||
    !literal.members.every(
      (member) =>
        ts.isPropertySignature(member) &&
        member.type !== undefined &&
        !derivedComposition(checker, member.type, copy.owner)
    )
  ) {
    return false;
  }
  recordProof(
    search,
    literal,
    projectionProof(checker, local, copy.owner, fields, copy.site)
  );
  return true;
}

function recordFieldCopies(
  search: ContractProvenanceSearch,
  copy: LocalCopy,
  local: ts.Type,
  matching: readonly ts.Symbol[]
): void {
  for (const property of matching) {
    const node = localPropertyNode(search.checker, property, copy.owner);
    if (node && isProjectSource(node.getSourceFile())) {
      recordProof(
        search,
        node,
        projectionProof(
          search.checker,
          local,
          copy.owner,
          [property],
          copy.site
        )
      );
    }
  }
}

function collectNestedCopies(
  search: ContractProvenanceSearch,
  copy: LocalCopy,
  fields: readonly ts.Symbol[]
): void {
  const { checker } = search;
  for (const field of fields) {
    const ownerField = checker.getPropertyOfType(copy.owner.type, field.name);
    const ownerType =
      ownerField && sameModifiers(field, ownerField)
        ? checker.getNonNullableType(checker.getTypeOfSymbol(ownerField))
        : undefined;
    if (ownerType && objectType(ownerType)) {
      collectLocalCopies(search, {
        local: checker.getTypeOfSymbol(field),
        owner: {
          ...copy.owner,
          type: ownerType,
          label: `${copy.owner.label}[${JSON.stringify(field.name)}]`,
        },
        site: copy.site,
        onlyField: null,
        depth: copy.depth - 1,
      });
    }
  }
}

export function collectLocalCopies(
  search: ContractProvenanceSearch,
  copy: LocalCopy
): void {
  const { checker } = search;
  const local = nonNullable(checker, copy.local);
  if (
    !local ||
    !objectType(local) ||
    copy.depth === 0 ||
    local === copy.owner.type
  ) {
    return;
  }
  const copyKey = `${copy.depth}:${copy.onlyField ?? ""}`;
  const owners = search.copies.get(local) ?? new Map<string, Set<ts.Type>>();
  const ownerTypes = owners.get(copyKey) ?? new Set<ts.Type>();
  if (ownerTypes.has(copy.owner.type)) {
    return;
  }
  if (search.work.count >= 4096) {
    search.work.complete = false;
    return;
  }
  search.work.count += 1;
  ownerTypes.add(copy.owner.type);
  owners.set(copyKey, ownerTypes);
  search.copies.set(local, owners);
  const fields = checker.getPropertiesOfType(local);
  const matching = fields.filter(
    (field) =>
      (!copy.onlyField || field.name === copy.onlyField) &&
      sameProperty(
        search,
        field,
        checker.getPropertyOfType(copy.owner.type, field.name)
      )
  );
  if (
    !copy.onlyField &&
    recordWholeCopy(search, copy, local, fields, matching)
  ) {
    return;
  }
  recordFieldCopies(search, copy, local, matching);
  if (!copy.onlyField) {
    collectNestedCopies(search, copy, fields);
  }
}
