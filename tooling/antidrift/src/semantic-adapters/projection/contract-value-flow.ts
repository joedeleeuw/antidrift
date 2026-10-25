import ts from "typescript";

import type { StructuralTypeCandidate } from "../type-owner.mjs";
import { collectContractSites, isProjectSource } from "./contract-sites.ts";
import type { ContractSite, LocalContractScope } from "./contract-sites.ts";
import type { ContractProvenanceSearch } from "./contract-provenance-state.ts";
import { collectLocalCopies } from "./local-contract-copies.ts";
import type { OwnerProjectionIndex } from "./owner-projection.ts";
import {
  contextualOwner,
  maxOwnerDepth,
  nonNullable,
  ownerProjections,
} from "./owner-projection.ts";
import { createRelevantTypeIndex } from "./relevant-contracts.ts";
import {
  discriminantBridge,
  samePath,
  stableBridge,
  trustedSource,
  valuePath,
} from "./value-bridge.ts";

export function createProvenanceSearch(
  checker: ts.TypeChecker,
  candidates: readonly StructuralTypeCandidate[],
  localContracts: LocalContractScope,
  owners?: OwnerProjectionIndex
): ContractProvenanceSearch {
  const index = owners ?? ownerProjections(checker, candidates);
  const relevant = createRelevantTypeIndex(
    checker,
    localContracts.declarations
  );
  const incomplete = new Set<ts.Node>();
  const trackedOwners: OwnerProjectionIndex = {
    unresolved: index.unresolved,
    get size() {
      return index.size;
    },
    getDirect(type) {
      return index.getDirect(type);
    },
    get(type) {
      const owner = index.get(type);
      if (index.unresolved.has(type)) {
        for (const declaration of relevant.forType(type, maxOwnerDepth, true)) {
          incomplete.add(declaration);
        }
      }
      return owner;
    },
  };
  return {
    checker,
    owners: trackedOwners,
    relevant,
    comparisons: new Map(),
    copies: new Map(),
    bridges: new Map(),
    findings: new Map(),
    incomplete,
    work: { count: 0, complete: true },
  };
}

function relevantType(search: ContractProvenanceSearch, type: ts.Type) {
  return search.relevant.forType(nonNullable(search.checker, type)).size > 0;
}

function ownerOf(search: ContractProvenanceSearch, type: ts.Type | undefined) {
  const owned = nonNullable(search.checker, type);
  if (!owned) {
    return undefined;
  }
  const direct = search.owners.getDirect(owned);
  if (direct) {
    return direct;
  }
  return relevantType(search, owned) ? search.owners.get(owned) : undefined;
}

function anchorBridges(search: ContractProvenanceSearch, node: ts.Node): void {
  if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
    return;
  }
  if (ts.isConditionalExpression(node)) {
    const actual = search.checker.getTypeAtLocation(node);
    if (relevantType(search, actual)) {
      const contextual = search.checker.getContextualType(node);
      const owner = ownerOf(search, contextual);
      const bridge = owner && discriminantBridge(search.checker, node, owner);
      if (bridge) {
        const bridges = search.bridges.get(bridge.symbol) ?? [];
        bridges.push(bridge);
        search.bridges.set(bridge.symbol, bridges);
      }
    }
  }
  ts.forEachChild(node, (child) => {
    anchorBridges(search, child);
  });
}

function consumeCall(
  search: ContractProvenanceSearch,
  node: ts.CallExpression
): void {
  const actual = search.checker.getTypeAtLocation(node);
  const contextual = search.checker.getContextualType(node);
  if (!contextual) {
    return;
  }
  const owner = ownerOf(search, actual);
  if (owner) {
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
  search: ContractProvenanceSearch,
  node: ts.Identifier | ts.PropertyAccessExpression
): void {
  const { checker } = search;
  const actual = checker.getNonNullableType(checker.getTypeAtLocation(node));
  const contextual = checker.getContextualType(node);
  if (!contextual) {
    return;
  }
  const owner =
    trustedSource(checker, node) &&
    (search.owners.getDirect(actual) ??
      (relevantType(search, actual) ? search.owners.get(actual) : undefined));
  if (!owner && !relevantType(search, actual)) {
    return;
  }
  const path = valuePath(checker, node);
  if (!path) {
    return;
  }
  if (owner) {
    collectLocalCopies(search, {
      local: contextual,
      owner,
      site: node,
      onlyField: null,
      depth: maxOwnerDepth,
    });
  }
  const inputOwner = contextualOwner(checker, search.owners, contextual);
  if (inputOwner) {
    collectLocalCopies(search, {
      local: actual,
      owner: inputOwner,
      site: node,
      onlyField: null,
      depth: maxOwnerDepth,
    });
  }
  for (const bridge of search.bridges.get(path.symbol) ?? []) {
    if (samePath(path, bridge)) {
      collectLocalCopies(search, {
        local: contextual,
        owner: bridge.owner,
        site: node,
        onlyField: bridge.field,
        depth: maxOwnerDepth,
      });
    }
  }
}

export function collectContractValueFlow(
  program: ts.Program,
  filePaths: readonly string[],
  search: ContractProvenanceSearch
) {
  const allowedFiles = new Set(filePaths);
  const files = program
    .getSourceFiles()
    .filter(
      (file) =>
        isProjectSource(file) &&
        allowedFiles.has(file.fileName) &&
        !file.fileName.includes("/convex/_generated/")
    );
  for (const file of files) {
    anchorBridges(search, file);
  }
  for (const [symbol, bridges] of search.bridges) {
    search.bridges.set(
      symbol,
      bridges.filter((bridge) => stableBridge(search.checker, bridge))
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
}
