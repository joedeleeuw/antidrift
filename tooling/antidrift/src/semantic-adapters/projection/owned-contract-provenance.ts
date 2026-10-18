import ts from "typescript";

import { resolveAliasedSymbol } from "../provenance/symbol-provenance.ts";
import {
  boundedType,
  equivalentType,
  objectType,
  sameModifiers,
} from "../shape/contract-types.ts";
import type { StructuralTypeCandidate } from "../type-owner.mjs";
import type { OwnerProjection } from "./owner-projection.ts";
import {
  contextualOwner,
  derivedComposition,
  maxOwnerDepth,
  nonNullable,
  ownerProjections,
} from "./owner-projection.ts";
import type { DiscriminantBridge } from "./value-bridge.ts";
import {
  discriminantBridge,
  samePath,
  stableBridge,
  trustedSource,
  valuePath,
} from "./value-bridge.ts";

type ProjectionProof = ReturnType<typeof projectionProof>;

type ProvenanceSearch = {
  readonly checker: ts.TypeChecker;
  readonly owners: ReadonlyMap<ts.Type, OwnerProjection>;
  readonly bridges: Map<ts.Symbol, DiscriminantBridge[]>;
  readonly findings: Map<ts.Node, ProjectionProof>;
};

type LocalCopy = {
  readonly local: ts.Type | undefined;
  readonly owner: OwnerProjection;
  readonly site: ts.Node;
  readonly onlyField: string | null;
  readonly depth: number;
};

type ContractSite =
  | ts.CallExpression
  | ts.Identifier
  | ts.PropertyAccessExpression;

type CachedProvenance = {
  readonly candidates: readonly StructuralTypeCandidate[];
  readonly findings: ReadonlyMap<ts.Node, ProjectionProof>;
};

const provenanceByProgram = new WeakMap<ts.Program, CachedProvenance[]>();

function isProjectSource(file: ts.SourceFile): boolean {
  return !file.isDeclarationFile && !file.fileName.includes("/node_modules/");
}

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
  checker: ts.TypeChecker,
  local: ts.Symbol,
  owner: ts.Symbol | undefined
): boolean {
  if (!owner || !sameModifiers(local, owner)) {
    return false;
  }
  const localType = checker.getTypeOfSymbol(local);
  const ownerType = checker.getTypeOfSymbol(owner);
  return (
    boundedType(checker, localType) &&
    boundedType(checker, ownerType) &&
    equivalentType(checker, localType, ownerType)
  );
}

function projectionProof(
  checker: ts.TypeChecker,
  localType: ts.Type,
  owner: OwnerProjection,
  fields: readonly ts.Symbol[],
  site: ts.Node
) {
  const propertyTypes = fields.map((field): [string, string] => [
    field.name,
    checker.typeToString(checker.getTypeOfSymbol(field)),
  ]);
  return {
    authorityState: "accepted",
    diagnostic: { emitted: true, messageId: "ownedContractProjection" },
    localType: {
      name: localType.aliasSymbol?.name ?? "anonymous contract",
      props: propertyTypes,
    },
    ownerType: {
      authority: owner.authority,
      label: owner.label,
      props: propertyTypes,
    },
    structuralMatch: {
      matchedProps: fields.map((field) => field.name),
      relation: "proven-owner-projection",
      localPropCount: fields.length,
      ownerPropCount: checker.getPropertiesOfType(owner.type).length,
      provenance: {
        file: site.getSourceFile().fileName,
        start: site.getStart(),
      },
    },
  };
}

function recordWholeCopy(
  search: ProvenanceSearch,
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
  search.findings.set(
    literal,
    projectionProof(checker, local, copy.owner, fields, copy.site)
  );
  return true;
}

function recordFieldCopies(
  search: ProvenanceSearch,
  copy: LocalCopy,
  local: ts.Type,
  matching: readonly ts.Symbol[]
): void {
  for (const property of matching) {
    const node = localPropertyNode(search.checker, property, copy.owner);
    if (node && isProjectSource(node.getSourceFile())) {
      search.findings.set(
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
  search: ProvenanceSearch,
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

function collectLocalCopies(search: ProvenanceSearch, copy: LocalCopy): void {
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
  const fields = checker.getPropertiesOfType(local);
  const matching = fields.filter(
    (field) =>
      (!copy.onlyField || field.name === copy.onlyField) &&
      sameProperty(
        checker,
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

function ownerOf(search: ProvenanceSearch, type: ts.Type | undefined) {
  const owned = nonNullable(search.checker, type);
  return owned && search.owners.get(owned);
}

function anchorBridges(search: ProvenanceSearch, node: ts.Node): void {
  if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
    return;
  }
  if (ts.isConditionalExpression(node)) {
    const owner = ownerOf(search, search.checker.getContextualType(node));
    const bridge = owner && discriminantBridge(search.checker, node, owner);
    if (bridge) {
      const bridges = search.bridges.get(bridge.symbol) ?? [];
      bridges.push(bridge);
      search.bridges.set(bridge.symbol, bridges);
    }
  }
  ts.forEachChild(node, (child) => {
    anchorBridges(search, child);
  });
}

function consumeCall(search: ProvenanceSearch, node: ts.CallExpression): void {
  const owner = ownerOf(search, search.checker.getTypeAtLocation(node));
  const contextual = search.checker.getContextualType(node);
  if (owner && contextual) {
    collectLocalCopies(search, {
      local: contextual,
      owner,
      site: node,
      onlyField: null,
      depth: maxOwnerDepth,
    });
  }
}

function consumeReference(
  search: ProvenanceSearch,
  node: ts.Identifier | ts.PropertyAccessExpression
): void {
  const { checker } = search;
  const path = valuePath(checker, node);
  const contextual = checker.getContextualType(node);
  if (!path || !contextual) {
    return;
  }
  const actual = checker.getNonNullableType(checker.getTypeAtLocation(node));
  const origin = { site: node, depth: maxOwnerDepth };
  const owner = trustedSource(checker, node) && search.owners.get(actual);
  if (owner) {
    collectLocalCopies(search, {
      ...origin,
      local: contextual,
      owner,
      onlyField: null,
    });
  }
  const inputOwner = contextualOwner(checker, search.owners, contextual);
  if (inputOwner) {
    collectLocalCopies(search, {
      ...origin,
      local: actual,
      owner: inputOwner,
      onlyField: null,
    });
  }
  for (const bridge of search.bridges.get(path.symbol) ?? []) {
    if (samePath(path, bridge)) {
      collectLocalCopies(search, {
        ...origin,
        local: contextual,
        owner: bridge.owner,
        onlyField: bridge.field,
      });
    }
  }
}

function collectContractSites(node: ts.Node, sites: ContractSite[]): void {
  if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
    return;
  }
  if (
    ts.isCallExpression(node) ||
    ts.isIdentifier(node) ||
    ts.isPropertyAccessExpression(node)
  ) {
    sites.push(node);
  }
  ts.forEachChild(node, (child) => {
    collectContractSites(child, sites);
  });
}

function sameCandidates(
  cachedCandidates: readonly StructuralTypeCandidate[],
  accepted: readonly StructuralTypeCandidate[]
): boolean {
  return (
    cachedCandidates.length === accepted.length &&
    accepted.every((candidate, index) => {
      const cachedCandidate = cachedCandidates[index];
      return (
        cachedCandidate !== undefined &&
        candidate.type === cachedCandidate.type &&
        candidate.label === cachedCandidate.label &&
        candidate.authority === cachedCandidate.authority
      );
    })
  );
}

export function collectOwnedContractProvenance(
  program: ts.Program,
  checker: ts.TypeChecker,
  candidates: readonly StructuralTypeCandidate[]
) {
  const accepted = candidates.filter(
    (candidate) => candidate.authorityState === "accepted"
  );
  const programCache = provenanceByProgram.get(program) ?? [];
  provenanceByProgram.set(program, programCache);
  const cached = programCache.find((entry) =>
    sameCandidates(entry.candidates, accepted)
  );
  if (cached) {
    return cached.findings;
  }
  const search: ProvenanceSearch = {
    checker,
    owners: ownerProjections(checker, candidates),
    bridges: new Map(),
    findings: new Map(),
  };
  const files = program
    .getSourceFiles()
    .filter(
      (file) =>
        isProjectSource(file) && !file.fileName.includes("/convex/_generated/")
    );
  for (const file of files) {
    anchorBridges(search, file);
  }
  for (const [symbol, bridges] of search.bridges) {
    search.bridges.set(
      symbol,
      bridges.filter((bridge) => stableBridge(checker, bridge))
    );
  }
  for (const file of files) {
    const sites: ContractSite[] = [];
    collectContractSites(file, sites);
    for (const site of sites) {
      if (ts.isCallExpression(site)) {
        consumeCall(search, site);
      } else {
        consumeReference(search, site);
      }
    }
  }
  programCache.push({ candidates: accepted, findings: search.findings });
  return search.findings;
}
